import type { Application } from '../application'
import type { DispatchArgs, DispatchOptions, JobDefinition } from '../queue/job'
import type { MaybePromise } from '../utils'
import { Cron } from 'croner'
import { parseDuration } from '../utils'

const kSchedule = Symbol.for('hazejs.schedule')

type TaskFn = () => MaybePromise<unknown>

/** 定时任务（链式配置频率与约束） */
export class ScheduledTask {
  #fields = ['*', '*', '*', '*', '*']
  #expression: string | undefined
  #timezone: string | undefined
  #overlapTtl: number | undefined
  #oneServer = false
  readonly #filters: Array<() => MaybePromise<boolean>> = []
  #cron: Cron | undefined
  onSuccessHook: TaskFn | undefined
  onFailureHook: ((error: unknown) => MaybePromise<unknown>) | undefined

  constructor(readonly name: string, readonly run: TaskFn, readonly kind: 'call' | 'job' = 'call') {}

  /** 完整的 cron 表达式（5 位：分 时 日 月 周；6 位含秒） */
  get expression(): string {
    return this.#expression ?? this.#fields.join(' ')
  }

  get timezoneName(): string | undefined {
    return this.#timezone
  }

  get preventsOverlap(): boolean {
    return this.#overlapTtl !== undefined
  }

  get overlapTtl(): number | undefined {
    return this.#overlapTtl
  }

  get runsOnOneServer(): boolean {
    return this.#oneServer
  }

  #set(index: number, value: string): this {
    this.#expression = undefined
    this.#cron = undefined
    this.#fields[index] = value
    return this
  }

  cron(expression: string): this {
    this.#expression = expression
    this.#cron = undefined
    return this
  }

  everyMinute(): this {
    return this.cron('* * * * *')
  }

  everyTwoMinutes(): this {
    return this.cron('*/2 * * * *')
  }

  everyFiveMinutes(): this {
    return this.cron('*/5 * * * *')
  }

  everyTenMinutes(): this {
    return this.cron('*/10 * * * *')
  }

  everyFifteenMinutes(): this {
    return this.cron('*/15 * * * *')
  }

  everyThirtyMinutes(): this {
    return this.cron('*/30 * * * *')
  }

  hourly(): this {
    return this.cron('0 * * * *')
  }

  hourlyAt(minute: number): this {
    return this.cron(`${minute} * * * *`)
  }

  daily(): this {
    return this.cron('0 0 * * *')
  }

  /** `dailyAt('13:30')` */
  dailyAt(time: string): this {
    return this.daily().at(time)
  }

  twiceDaily(first = 1, second = 13): this {
    return this.cron(`0 ${first},${second} * * *`)
  }

  weekly(): this {
    return this.cron('0 0 * * 0')
  }

  /** `weeklyOn(1, '08:00')`：0 为周日 */
  weeklyOn(day: number, time = '00:00'): this {
    return this.cron(`0 0 * * ${day}`).at(time)
  }

  monthly(): this {
    return this.cron('0 0 1 * *')
  }

  monthlyOn(day = 1, time = '00:00'): this {
    return this.cron(`0 0 ${day} * *`).at(time)
  }

  /** 设置时分：`daily().at('03:00')` */
  at(time: string): this {
    const [hour, minute = '0'] = time.split(':')
    if (this.#expression)
      this.#fields = this.#expression.split(' ')
    this.#set(1, String(Number(hour)))
    return this.#set(0, String(Number(minute)))
  }

  weekdays(): this {
    if (this.#expression)
      this.#fields = this.#expression.split(' ')
    return this.#set(4, '1-5')
  }

  weekends(): this {
    if (this.#expression)
      this.#fields = this.#expression.split(' ')
    return this.#set(4, '0,6')
  }

  /** 时区（IANA 名称，如 Asia/Shanghai），默认 config/schedule.ts 的 timezone，否则 UTC */
  timezone(name: string): this {
    this.#timezone = name
    this.#cron = undefined
    return this
  }

  /** 上一次还未结束时跳过（缓存锁，ttl 后自动释放，默认 24h） */
  withoutOverlapping(ttl: string | number = '24h'): this {
    this.#overlapTtl = parseDuration(ttl)
    return this
  }

  /** 多实例时同一时刻只在一个实例执行（缓存锁） */
  onOneServer(): this {
    this.#oneServer = true
    return this
  }

  /** 条件为真时才执行 */
  when(filter: () => MaybePromise<boolean>): this {
    this.#filters.push(filter)
    return this
  }

  skip(filter: () => MaybePromise<boolean>): this {
    this.#filters.push(async () => !(await filter()))
    return this
  }

  onSuccess(hook: TaskFn): this {
    this.onSuccessHook = hook
    return this
  }

  onFailure(hook: (error: unknown) => MaybePromise<unknown>): this {
    this.onFailureHook = hook
    return this
  }

  #pattern(defaultTimezone?: string): Cron {
    this.#cron ??= new Cron(this.expression, { timezone: this.#timezone ?? defaultTimezone ?? 'UTC', paused: true })
    return this.#cron
  }

  /** 该分钟是否到期（秒忽略） */
  isDue(date: Date, defaultTimezone?: string): boolean {
    const minute = new Date(Math.floor(date.getTime() / 60_000) * 60_000)
    return this.#pattern(defaultTimezone).match(minute)
  }

  nextRun(from: Date = new Date(), defaultTimezone?: string): Date | null {
    return this.#pattern(defaultTimezone).nextRun(from)
  }

  async passesFilters(): Promise<boolean> {
    for (const filter of this.#filters) {
      if (!(await filter()))
        return false
    }
    return true
  }
}

/** s.job() 到期时的投递方式（Scheduler 传入所属应用的 QueueManager） */
export type ScheduleDispatcher = (job: JobDefinition<any>, payload: unknown, options: DispatchOptions) => Promise<unknown>

/** 定义定时任务的构造器 */
export class Schedule {
  readonly tasks: ScheduledTask[] = []

  /**
   * nameOf：已注册任务的名字（app/job 的文件名）；
   * dispatch：s.job() 的投递方式，默认 `job.dispatch()`（解析到当前上下文的应用）
   */
  constructor(
    private readonly nameOf: (job: JobDefinition<any>) => string = job => job.name ?? 'anonymous',
    private readonly dispatch: ScheduleDispatcher = (job, payload, options) => job.dispatch(payload, options),
  ) {}

  #add(task: ScheduledTask): ScheduledTask {
    if (this.tasks.some(item => item.name === task.name))
      throw new Error(`Duplicate scheduled task "${task.name}"`)
    this.tasks.push(task)
    return task
  }

  /** 执行函数：`s.call('report', () => sendReport()).dailyAt('09:00')` */
  call(name: string, fn: TaskFn): ScheduledTask {
    return this.#add(new ScheduledTask(name, fn))
  }

  /** 按 cron 表达式执行：`s.cron('*\/5 * * * *', 'sync', fn)` */
  cron(expression: string, name: string, fn: TaskFn): ScheduledTask {
    return this.call(name, fn).cron(expression)
  }

  /**
   * 到期时投递任务到队列（只负责投递，执行由队列 worker 完成）；无载荷的任务可以省略 payload：`s.job(PruneTokens).daily()`
   */
  job<P>(job: JobDefinition<P>, ...args: DispatchArgs<P, DispatchOptions & { name?: string }>): ScheduledTask {
    const [payload, { name: taskName, ...options } = {}] = args as [P, (DispatchOptions & { name?: string })?]
    const name = taskName ?? `job:${this.nameOf(job)}`
    return this.#add(new ScheduledTask(name, () => this.dispatch(job, payload, options), 'job'))
  }
}

/** defineSchedule 的回调：第二个参数为所属应用（`s.call(...).skip(() => app.make(AppEnv).isLocal)`） */
export type ScheduleDefine = (schedule: Schedule, app: Application) => void

export interface ScheduleDefinition {
  readonly [kSchedule]: true
  readonly define: ScheduleDefine
}

/**
 * schedule/*.ts 的默认导出：
 *
 * ```ts
 * export default defineSchedule((s, app) => {
 *   s.job(PruneTokens).daily().skip(() => app.config.get('app.env') === 'local')
 * })
 * ```
 */
export function defineSchedule(define: ScheduleDefine): ScheduleDefinition {
  return { [kSchedule]: true, define }
}

export function isScheduleDefinition(value: unknown): value is ScheduleDefinition {
  return typeof value === 'object' && value !== null && kSchedule in value
}
