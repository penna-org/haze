import type { DevServer } from '@hazejs/vite'
import process from 'node:process'
import { createDevServer } from '@hazejs/vite'
import { defineCommand } from 'citty'
import { consola } from 'consola'
import { appCore } from '../app-import'
import { resolveRoot, rootArg } from '../args'

type Core = typeof import('@hazejs/core')

/** 在应用的模块图中运行（不监听端口）；keepAlive 时保持运行，文件变化后应用热替换 */
async function withApp<T>(root: string, run: (server: DevServer, core: Core) => Promise<T>, keepAlive = false): Promise<T> {
  const server = await createDevServer({ root, listen: false })
  if (!server.app) {
    await server.close()
    throw new Error('Application failed to start')
  }
  try {
    // 与应用同一份 @hazejs/core（应用的依赖被外部化时 server.import 拿到的是另一份实例）
    const core = await appCore(server, root)
    return await run(server, core)
  }
  finally {
    if (!keepAlive)
      await server.close()
  }
}

/** 等待 Ctrl+C / SIGTERM，然后执行清理 */
function untilSignal(cleanup: () => Promise<void>): Promise<void> {
  return new Promise((resolve) => {
    const stop = async (): Promise<void> => {
      consola.info('Stopping…')
      await cleanup()
      resolve()
    }
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
  })
}

const connectionArg = {
  connection: { type: 'string', description: '队列连接（默认 config/queue.ts 的 default）' },
} as const

export const queueWorkCommand = defineCommand({
  meta: { name: 'queue:work', description: '消费队列任务（任务代码修改后自动生效）' },
  args: {
    ...rootArg,
    ...connectionArg,
    queue: { type: 'string', alias: 'q', description: '队列名，逗号分隔（按优先级），默认 default' },
    concurrency: {
      type: 'string',
      alias: 'c',
      description: '并发数，默认 1',
      default: '1',
    },
  },
  async run({ args }) {
    const root = resolveRoot(args.root)
    await withApp(root, async (server, core) => {
      const manager = (): InstanceType<Core['QueueManager']> => server.app!.make(core.QueueManager)
      const queues = args.queue?.split(',').map(name => name.trim()).filter(Boolean) ?? ['default']
      const worker = await manager().work({
        connection: args.connection,
        queues,
        concurrency: Number(args.concurrency),
        resolve: manager,
      })
      consola.success(`Processing ${queues.join(', ')} (${manager().config.connections[args.connection ?? manager().config.default]?.driver} connection, concurrency ${args.concurrency})`)
      await untilSignal(async () => {
        await worker.stop()
        await server.close()
      })
    }, true)
  },
})

export const queueFailedCommand = defineCommand({
  meta: { name: 'queue:failed', description: '列出失败的任务' },
  args: {
    ...rootArg,
    ...connectionArg,
  },
  async run({ args }) {
    await withApp(resolveRoot(args.root), async (server, core) => {
      const failed = await server.app!.make(core.QueueManager).failed(args.connection)
      if (!failed.length) {
        consola.info('No failed jobs')
        return
      }
      for (const job of failed)
        console.log(`${job.id}  ${job.job}  [${job.queue}]  ${new Date(job.failedAt).toISOString()}  attempts=${job.attempts}\n  ${job.error.split('\n')[0]}`)
    })
  },
})

export const queueRetryCommand = defineCommand({
  meta: { name: 'queue:retry', description: '重新投递失败的任务（不传 id 为全部）' },
  args: {
    ...rootArg,
    ...connectionArg,
    id: { type: 'positional', required: false, description: '任务 ID' },
  },
  async run({ args }) {
    await withApp(resolveRoot(args.root), async (server, core) => {
      const count = await server.app!.make(core.QueueManager).retry(args.id, args.connection)
      consola.success(`Retried ${count} job(s)`)
    })
  },
})

export const queueForgetCommand = defineCommand({
  meta: { name: 'queue:forget', description: '删除一个失败的任务' },
  args: {
    ...rootArg,
    ...connectionArg,
    id: { type: 'positional', required: true, description: '任务 ID' },
  },
  async run({ args }) {
    await withApp(resolveRoot(args.root), async (server, core) => {
      const removed = await server.app!.make(core.QueueManager).forget(args.id, args.connection)
      if (removed)
        consola.success(`Removed ${args.id}`)
      else
        consola.warn(`No failed job ${args.id}`)
    })
  },
})

export const queueFlushCommand = defineCommand({
  meta: { name: 'queue:flush', description: '清空失败的任务' },
  args: {
    ...rootArg,
    ...connectionArg,
  },
  async run({ args }) {
    await withApp(resolveRoot(args.root), async (server, core) => {
      consola.success(`Removed ${await server.app!.make(core.QueueManager).flush(args.connection)} failed job(s)`)
    })
  },
})

export const scheduleListCommand = defineCommand({
  meta: { name: 'schedule:list', description: '列出定时任务与下次执行时间' },
  args: rootArg,
  async run({ args }) {
    await withApp(resolveRoot(args.root), async (server, core) => {
      const scheduler = server.app!.make(core.Scheduler)
      const tasks = scheduler.tasks()
      if (!tasks.length) {
        consola.info('No scheduled tasks (schedule/*.ts)')
        return
      }
      const width = Math.max(...tasks.map(task => task.name.length))
      for (const task of tasks) {
        const flags = [task.runsOnOneServer && 'onOneServer', task.preventsOverlap && 'withoutOverlapping'].filter(Boolean).join(', ')
        const timezone = task.timezoneName ?? scheduler.config.timezone ?? 'UTC'
        console.log(`${task.name.padEnd(width)}  ${task.expression.padEnd(15)}  ${timezone.padEnd(15)}  next ${task.nextRun(new Date(), scheduler.config.timezone)?.toISOString() ?? '-'}${flags
          ? `  (${flags})`
          : ''}`)
      }
    })
  },
})

export const scheduleRunCommand = defineCommand({
  meta: { name: 'schedule:run', description: '执行当前分钟到期的定时任务（配合系统 cron 每分钟调用）' },
  args: rootArg,
  async run({ args }) {
    await withApp(resolveRoot(args.root), async (server, core) => {
      const runs = await server.app!.make(core.Scheduler).runDue()
      if (!runs.length)
        consola.info('No scheduled tasks are due')
      for (const run of runs) {
        consola[run.status === 'failed'
          ? 'error'
          : run.status === 'ok'
            ? 'success'
            : 'info'](`${run.name}: ${run.status}${run.reason
          ? ` (${run.reason})`
          : ''}`)
      }
      if (runs.some(run => run.status === 'failed'))
        process.exitCode = 1
    })
  },
})

export const scheduleWorkCommand = defineCommand({
  meta: { name: 'schedule:work', description: '常驻执行定时任务（每分钟整点检查）' },
  args: rootArg,
  async run({ args }) {
    await withApp(resolveRoot(args.root), async (server, core) => {
      const controller = new AbortController()
      consola.success(`Scheduler started (${server.app!.make(core.Scheduler).tasks().length} task(s))`)
      // 每分钟取最新的应用（热替换后任务定义随之更新）
      const loop = (async () => {
        while (!controller.signal.aborted) {
          await server.app!.make(core.Scheduler).work(AbortSignal.any([
            controller.signal,
            AbortSignal.timeout(61_000),
          ]))
        }
      })()
      await untilSignal(async () => {
        controller.abort()
        await loop
        await server.close()
      })
    }, true)
  },
})
