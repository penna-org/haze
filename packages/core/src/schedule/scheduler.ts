import type { Application } from '../application'
import type { CacheRepository } from '../cache/repository'
import type { ScheduleDefinition, ScheduledTask } from './schedule'
import { CacheManager } from '../cache/manager'
import { QueueManager } from '../queue/manager'
import { isScheduleDefinition, Schedule } from './schedule'

export interface ScheduleConfig {
  /** 默认时区（IANA），默认 UTC */
  timezone?: string
  /** onOneServer / withoutOverlapping 使用的缓存存储（须为原子存储），默认缓存的默认存储 */
  store?: string
}

/** `config/schedule.ts` 的默认导出 */
export function defineScheduleConfig(config: ScheduleConfig | (() => ScheduleConfig)): ScheduleConfig | (() => ScheduleConfig) {
  return config
}

export interface TaskRun {
  name: string
  status: 'ok' | 'failed' | 'skipped'
  reason?: 'filter' | 'overlapping' | 'other-server'
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

  /** 全部定时任务 */
  tasks(): ScheduledTask[] {
    if (!this.#tasks) {
      const queue = this.app.make(QueueManager)
      const schedule = new Schedule(job => queue.nameOf(job))
      this.#definitions.forEach(definition => definition.define(schedule))
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

  /** 执行一个任务（含 onOneServer / withoutOverlapping 检查） */
  async runTask(task: ScheduledTask, date: Date = new Date()): Promise<TaskRun> {
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
      logger.info(`Scheduled task done in ${Math.round(performance.now() - started)}ms`)
      return { name: task.name, status: 'ok', duration: performance.now() - started }
    }
    catch (error) {
      logger.error('Scheduled task failed', error)
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

  /** 执行该分钟到期的任务（think-h3 schedule:run / Cron Triggers / EventBridge） */
  async runDue(date: Date = new Date()): Promise<TaskRun[]> {
    return Promise.all(this.due(date).map(task => this.runTask(task, date)))
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
