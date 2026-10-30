import type { Application } from '../application'
import type { QueueWorker } from '../queue/manager'
import { QueueManager } from '../queue/manager'
import { Scheduler } from '../schedule/scheduler'
import { registerServerExtension, unregisterServerExtension } from './extensions'

/** `config/queue.ts` 的 runInServer：HTTP 服务器进程中同时消费队列（单进程部署、开发） */
export interface QueueRunInServer {
  /** 连接，默认队列配置的 default */
  connection?: string
  /** 消费的队列（按优先级），默认 ['default'] */
  queues?: string[]
  /** 并发数，默认 1 */
  concurrency?: number
}

/**
 * queue.runInServer 的连接是否需要 worker：sync 在投递时执行（提示一次后跳过），
 * memory 首次使用即在本进程消费（只消费 default 队列；指定了其它队列或并发数时仍启动 worker）
 */
function needsWorker(app: Application, options: QueueRunInServer): boolean {
  const manager = app.make(QueueManager)
  const name = options.connection ?? manager.config.default
  const driver = manager.config.connections[name]?.driver
  if (driver === 'sync') {
    app.logger.warn(`queue.runInServer: connection "${name}" uses the sync driver, which runs jobs when they are dispatched; no worker is started (remove runInServer or use another connection)`)
    return false
  }
  if (driver === 'memory') {
    const queues = options.queues ?? ['default']
    return options.concurrency !== undefined || queues.length !== 1 || queues[0] !== 'default'
  }
  return true
}

/**
 * 进程内的定时任务与队列消费（`schedule.runInServer` / `queue.runInServer`）：
 * HTTP 服务器开始监听时启动（haze dev、haze start、node / docker 产物），应用释放时停止；
 * 测试与命令行不监听端口，不会启动。多实例部署请改用独立的 worker 进程（haze schedule:work / queue:work）
 */
export function registerInProcessWorkers(app: Application): (() => Promise<void>) | undefined {
  const schedule = app.config.get<boolean>('schedule.runInServer', false)
  const queue = app.config.get<boolean | QueueRunInServer>('queue.runInServer', false)
  if (!schedule && !queue)
    return undefined

  const controller = new AbortController()
  let started: Promise<{ loop?: Promise<void>, worker?: QueueWorker }> | undefined
  const start = (): void => {
    started ??= (async () => {
      const loop = schedule
        ? app.make(Scheduler).work(controller.signal).catch(error => app.logger.error('In-process scheduler stopped', error))
        : undefined
      const options = queue === true
        ? {}
        : queue || {}
      let worker: QueueWorker | undefined
      if (queue && needsWorker(app, options)) {
        worker = await app.make(QueueManager).work(options).catch((error: unknown) => {
          app.logger.error('In-process queue worker failed to start', error)
          return undefined
        })
      }
      app.logger.debug(`In-process workers started (${[schedule && 'schedule', worker && 'queue'].filter(Boolean).join(', ') || 'none'})`)
      return { loop, worker }
    })()
  }
  const extension = {
    name: 'haze:in-process-workers',
    matches: () => false,
    node: start,
  }
  registerServerExtension(extension)

  return async () => {
    unregisterServerExtension(extension.name, extension)
    controller.abort()
    if (!started)
      return
    const { loop, worker } = await started
    await worker?.stop()
    await loop
  }
}
