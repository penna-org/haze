import type { Application } from '../application'
import type { CacheRepository } from '../cache/repository'
import type { ScheduleDefinition, ScheduledTask } from './schedule'
import { CacheManager } from '../cache/manager'
import { MaintenanceManager } from '../maintenance/manager'
import { recordTelemetry, telemetryActive } from '../observability/telemetry'
import { QueueManager } from '../queue/manager'
import { runInApp } from '../request'
import { isScheduleDefinition, Schedule } from './schedule'

export interface ScheduleConfig {
  /** 默认时区（IANA），默认 UTC */
  timezone?: string
  /** onOneServer / withoutOverlapping 使用的缓存存储（须为原子存储），默认缓存的默认存储 */
  store?: string
  /** 在 HTTP 服务器进程中执行定时任务（单进程部署、开发），不需要另外运行 haze schedule:work；默认 false */
  runInServer?: boolean
}

/** `config/schedule.ts` 的默认导出 */
export function defineScheduleConfig(config: ScheduleConfig | (() => ScheduleConfig)): ScheduleConfig | (() => ScheduleConfig) {
  return config
}

export interface TaskRun {
  name: string
  status: 'ok' | 'failed' | 'skipped'
  reason?: 'filter' | 'overlapping' | 'other-server' | 'maintenance'
  error?: unknown
  duration: number
}

/** 定时任务调度（应用单例，`inject(Scheduler)`） */
export class Scheduler {
  readonly #definitions: ScheduleDefinition[] = []
  #tasks: ScheduledTask[] | undefined

  constructor(readonly app: Application) {}

  get config(): ScheduleConfig {
    return this.app.config.get<ScheduleConfig>('schedule', {})
  }

  register(definition: unknown): this {
    if (!isScheduleDefinition(definition))
      throw new TypeError('schedule/*.ts must export default defineSchedule(...)')
    this.#definitions.push(definition)
    this.#tasks = undefined
    return this
  }

  /** 全部定时任务（defineSchedule 的回调在应用上下文中执行，收到应用；s.job() 投递到这个应用的队列） */
  tasks(): ScheduledTask[] {
    if (!this.#tasks) {
      const queue = this.app.make(QueueManager)
      const schedule = new Schedule(job => queue.nameOf(job), (job, payload, options) => queue.dispatch(job, payload, options))
      runInApp(this.app, () => this.#definitions.forEach(definition => definition.define(schedule, this.app)))
      this.#tasks = schedule.tasks
    }
    return this.#tasks
  }

  /** 该分钟到期的任务 */
  due(date: Date = new Date()): ScheduledTask[] {
    return this.tasks().filter(task => task.isDue(date, this.config.timezone))
  }

  #cache(): CacheRepository {
    const cache = this.app.make(CacheManager).store(this.config.store)
    if (!cache.store.atomic)
      throw new Error(`Scheduled task locks need an atomic cache store; "${cache.name}" (${cache.store.driver}) is not. Set schedule.store in config/schedule.ts`)
    return cache
  }

  /**
   * 执行一个任务（含 onOneServer / withoutOverlapping 检查）：在应用上下文中执行，
   * 条件、任务函数与钩子中的门面（Queue、Events、Db、useApp()、config()、inject()）解析到这个应用
   */
  runTask(task: ScheduledTask, date: Date = new Date()): Promise<TaskRun> {
    return runInApp(this.app, () => this.#recordRun(task, date))
  }

  /** 执行并记录定时任务遥测 */
  async #recordRun(task: ScheduledTask, date: Date): Promise<TaskRun> {
    const startTime = Date.now()
    const run = await this.#runTask(task, date)
    if (telemetryActive()) {
      recordTelemetry('schedule', {
        name: run.name,
        kind: task.kind,
        status: run.status,
        reason: run.reason,
        startTime,
        duration: run.duration,
        ...(run.error !== undefined && {
          error: run.error instanceof Error
            ? run.error.message
            : String(run.error),
        }),
      })
    }
    return run
  }

  async #runTask(task: ScheduledTask, date: Date): Promise<TaskRun> {
    const started = performance.now()
    const logger = this.app.logger.child({ task: task.name })
    if (!(await task.passesFilters())) {
      return {
        name: task.name,
        status: 'skipped',
        reason: 'filter',
        duration: 0,
      }
    }
    if (task.runsOnOneServer) {
      // 按分钟加锁且不释放：同一时刻的其它实例拿不到
      const slot = new Date(Math.floor(date.getTime() / 60_000) * 60_000).toISOString()
      if (!(await this.#cache().lock(`schedule:${task.name}:${slot}`, 3600).get())) {
        return {
          name: task.name,
          status: 'skipped',
          reason: 'other-server',
          duration: 0,
        }
      }
    }
    const overlap = task.preventsOverlap
      ? this.#cache().lock(`schedule:${task.name}:running`, task.overlapTtl)
      : undefined
    if (overlap && !(await overlap.get())) {
      return {
        name: task.name,
        status: 'skipped',
        reason: 'overlapping',
        duration: 0,
      }
    }
    try {
      await task.run()
      await task.onSuccessHook?.()
      // s.job()：这里只是投递到队列，任务由 worker 执行（执行结果见队列日志）
      logger.info(task.kind === 'job'
        ? `Scheduled job dispatched to the queue in ${Math.round(performance.now() - started)}ms`
        : `Scheduled task done in ${Math.round(performance.now() - started)}ms`)
      return { name: task.name, status: 'ok', duration: performance.now() - started }
    }
    catch (error) {
      logger.error(task.kind === 'job'
        ? 'Scheduled job could not be dispatched'
        : 'Scheduled task failed', error)
      await Promise.resolve(task.onFailureHook?.(error)).catch(hookError => logger.error('onFailure hook threw', hookError))
      return {
        name: task.name,
        status: 'failed',
        error,
        duration: performance.now() - started,
      }
    }
    finally {
      await overlap?.release()
    }
  }

  /** 执行该分钟到期的任务（haze schedule:run / Cron Triggers / EventBridge） */
  async runDue(date: Date = new Date()): Promise<TaskRun[]> {
    // 维护模式（pauseWorkers）：到期的任务全部跳过
    const due = this.due(date)
    if (due.length && this.app.container.has(MaintenanceManager) && await this.app.make(MaintenanceManager).pausesScheduler()) {
      this.app.logger.info(`Application is in maintenance mode, skipped ${due.length} scheduled task(s)`)
      return due.map(task => ({
        name: task.name,
        status: 'skipped',
        reason: 'maintenance',
        duration: 0,
      }))
    }
    return Promise.all(due.map(task => this.runTask(task, date)))
  }

  /** 常驻：每分钟整点执行到期任务，直到 signal 中止 */
  async work(signal?: AbortSignal): Promise<void> {
    while (!signal?.aborted) {
      const now = Date.now()
      const next = Math.floor(now / 60_000) * 60_000 + 60_000
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, next - now)
        signal?.addEventListener('abort', () => {
          clearTimeout(timer)
          resolve()
        }, { once: true })
      })
      if (!signal?.aborted)
        await this.runDue(new Date(next))
    }
  }
}
