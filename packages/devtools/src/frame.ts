import type { AppIntrospection, DashboardEntry } from '@hazejs/core'
import type { DevframeDefinition, DevframeNodeContext } from 'devframe'
import type { EntrySource } from './data'
import type { DevtoolsSource } from './hub'
import { fileURLToPath } from 'node:url'
import { useDashboardStore } from '@hazejs/core'
import { defineDevframe } from 'devframe'
import { z } from 'zod'
import { aiSummary, buildGraph, listRequests, requestDetail } from './data'
import { filterRoutes } from './inspect'

export const FRAME_ID = 'hazejs'

/** 页面路由（SPA 的 hash），每个页面对应一个面板 */
export const PAGES = ['graph', 'requests', 'ai', 'tasks'] as const
export type Page = typeof PAGES[number]

/** 通知前端刷新：应用重载与新的记录各自计数 */
export interface Revision {
  reload: number
  entries: number
}

interface FrameOptions {
  source: DevtoolsSource
  /** 测试中替换开发面板的记录 */
  entries?: EntrySource
}

const PACKAGE = {
  version: '0.2.0',
  packageName: '@hazejs/devtools',
  homepage: 'https://github.com/penna-org/haze',
}

/**
 * hazejs 自己的面板（Vue SPA）与 RPC：模块联动图、请求瀑布图、AI 调用、定时任务与队列。
 * 运行在开发服务器进程中；应用的结构通过 `app.introspect()` 读取，
 * 需要应用内部类的操作（执行定时任务、调用模型）通过 `source.import()` 取应用模块图中的那一份。
 */
export function createHazeFrame({ source, entries }: FrameOptions): DevframeDefinition {
  const store = (): EntrySource => entries ?? useDashboardStore()
  const snapshot = (): AppIntrospection | null => {
    try {
      return source.app?.introspect() ?? null
    }
    catch {
      return null
    }
  }
  const recent = (): DashboardEntry[] => store().list({ limit: 500 })

  return defineDevframe({
    id: FRAME_ID,
    name: 'hazejs',
    description: 'hazejs application inspector',
    ...PACKAGE,
    importMetaUrl: import.meta.url,
    clientAssets: fileURLToPath(new URL('./client', import.meta.url)),
    // 静态报告（buildReport）只烘焙应用结构：快照与联动图
    capabilities: { build: true },
    async setup(ctx: DevframeNodeContext) {
      const rpc = ctx.rpc

      const revision = await rpc.sharedState.get(`${FRAME_ID}:revision`, {
        initialValue: { reload: 0, entries: 0 } as Revision,
      })
      source.onReload(() => revision.mutate((draft) => {
        draft.reload++
      }))
      // 新记录合并通知，避免高频请求时刷屏
      let timer: ReturnType<typeof setTimeout> | undefined
      const subscribe = (store() as { subscribe?: (listener: () => void) => () => void }).subscribe
      subscribe?.call(store(), () => {
        timer ??= setTimeout(() => {
          timer = undefined
          revision.mutate((draft) => {
            draft.entries++
          })
        }, 300)
      })

      rpc.register({
        name: `${FRAME_ID}:snapshot`,
        type: 'query',
        jsonSerializable: true,
        snapshot: true,
        agent: {
          title: 'Inspect the hazejs app',
          description: 'Structure of the running hazejs app: modules and what each contributes, sub-apps, routes with middleware, providers, container bindings, events and listeners, queue jobs, scheduled tasks. Call this first to understand the app before changing routes, modules, events or jobs.',
        },
        handler: () => snapshot(),
      })

      rpc.register({
        name: `${FRAME_ID}:routes`,
        type: 'query',
        jsonSerializable: true,
        args: [
          z.object({
            query: z.string().optional().describe('Words that must all appear in method, path, name, handler, middleware, module or app'),
          }),
        ],
        agent: {
          title: 'Find routes',
          description: 'Search the routes of the running hazejs app by method, path, name, handler, middleware, module or app. Use it to find which controller handles a URL or which routes use a middleware.',
        },
        handler: (input?: { query?: string }) => {
          const info = snapshot()
          if (!info)
            return []
          const rows = info.routes.map(route => ({
            method: route.method,
            path: route.domain
              ? `${route.domain}${route.path}`
              : route.path,
            name: route.name ?? '',
            handler: route.handler,
            middleware: [
              ...info.middleware.global,
              ...route.middleware,
            ].join(', '),
            module: route.module ?? '',
            app: route.app ?? '',
          }))
          return filterRoutes(rows, input?.query ?? '')
        },
      })

      rpc.register({
        name: `${FRAME_ID}:graph`,
        type: 'query',
        jsonSerializable: true,
        snapshot: true,
        agent: {
          title: 'Module graph',
          description: 'How the modules of the hazejs app depend on each other: event ownership and listeners, jobs and schedules, middleware used across modules, and events / jobs actually emitted or dispatched at runtime (with counts). Use it before changing an event, job or module that others may rely on.',
        },
        handler: () => {
          const info = snapshot()
          return info
            ? buildGraph(info, recent())
            : { nodes: [], edges: [] }
        },
      })

      rpc.register({
        name: `${FRAME_ID}:requests`,
        type: 'query',
        jsonSerializable: true,
        args: [
          z.object({
            limit: z.number().int().positive().optional().describe('How many requests to return, newest first (default 100)'),
          }).optional(),
        ],
        agent: {
          title: 'Recent requests',
          description: 'Recent HTTP requests handled by the dev server, newest first: status, duration, route, module, how many queries / cache calls / events / jobs each made, and how many queries repeated (likely N+1). Requires the dev dashboard (on by default in development).',
        },
        handler: (input?: { limit?: number }) => listRequests(store(), input?.limit ?? 100),
      })

      rpc.register({
        name: `${FRAME_ID}:request`,
        type: 'query',
        jsonSerializable: true,
        args: [
          z.object({
            requestId: z.string().describe('The request ID (x-request-id response header)'),
          }),
        ],
        agent: {
          title: 'Request timeline',
          description: 'Everything one request did, in order: SQL queries with params and timings, cache operations, events, dispatched and processed jobs, mail, logs, exceptions, AI and outgoing HTTP calls, plus repeated queries. Use it to debug a slow or failing request; get the requestId from the requests tool or the x-request-id response header.',
        },
        handler: ({ requestId }: { requestId: string }) => requestDetail(store(), requestId) ?? null,
      })

      rpc.register({
        name: `${FRAME_ID}:ai`,
        type: 'query',
        jsonSerializable: true,
        agent: {
          title: 'AI calls',
          description: 'Recent AI model calls made by the app: model, tokens, latency, finish reason, errors and, in development, the messages, output and tool calls. Use it to debug prompts and agent tool use.',
        },
        handler: () => aiSummary(store()),
      })

      rpc.register({
        name: `${FRAME_ID}:ai-models`,
        type: 'query',
        jsonSerializable: true,
        handler: async () => {
          const ai = await importAi(source)
          const registry = ai?.getModelRegistry()
          return {
            available: Boolean(ai),
            configured: Boolean(registry),
            default: registry?.defaults.language,
            aliases: Object.keys(registry?.aliases ?? {}),
            providers: Object.keys(registry?.providers ?? {}),
          }
        },
      })

      rpc.register({
        name: `${FRAME_ID}:ai-run`,
        type: 'action',
        jsonSerializable: true,
        handler: async (input: { model?: string, system?: string, prompt: string }) => {
          const ai = await importAi(source)
          if (!ai)
            return { error: '@hazejs/ai is not installed in this project' }
          const started = performance.now()
          try {
            const result = await ai.generateText({
              model: input.model || undefined,
              system: input.system || undefined,
              prompt: input.prompt,
            })
            return {
              text: result.text,
              usage: result.usage,
              finishReason: result.finishReason,
              duration: performance.now() - started,
            }
          }
          catch (error) {
            return { error: (error as Error).message, duration: performance.now() - started }
          }
        },
      })

      rpc.register({
        name: `${FRAME_ID}:tasks`,
        type: 'query',
        jsonSerializable: true,
        handler: async () => {
          const info = snapshot()
          const entries = store().list({ limit: 500 })
          const lastRuns = new Map<string, Record<string, unknown>>()
          const jobStats = new Map<string, { ok: number, failed: number, dispatched: number }>()
          for (const entry of entries) {
            if (entry.type === 'schedule')
              lastRuns.set(String(entry.content.name), { ...entry.content, time: entry.time })
            if (entry.type === 'job') {
              const name = String(entry.content.job)
              const stats = jobStats.get(name) ?? { ok: 0, failed: 0, dispatched: 0 }
              if (entry.content.status === 'dispatched')
                stats.dispatched++
              else if (entry.content.status === 'ok')
                stats.ok++
              else if (entry.content.status === 'failed')
                stats.failed++
              jobStats.set(name, stats)
            }
          }
          return {
            schedules: (info?.schedules ?? []).map(task => ({
              ...task,
              lastRun: lastRuns.get(task.name),
            })),
            jobs: (info?.jobs ?? []).map(job => ({ ...job, stats: jobStats.get(job.name) ?? { ok: 0, failed: 0, dispatched: 0 } })),
            queues: await queueCounts(source),
            dashboard: info?.dashboard?.path,
          }
        },
      })

      rpc.register({
        name: `${FRAME_ID}:run-schedule`,
        type: 'action',
        jsonSerializable: true,
        args: [
          z.object({
            name: z.string().describe('Scheduled task name, e.g. "job:SendDigest" or a call() task name'),
          }),
        ],
        agent: {
          title: 'Run a scheduled task now',
          description: 'Run one scheduled task of the hazejs app immediately (outside its cron schedule) and return its status. Use it to test a task after changing it. Get task names from the snapshot tool.',
          safety: 'action',
        },
        handler: async ({ name }: { name: string }) => {
          const app = source.app
          const core = await importCore(source)
          if (!app || !core)
            return { status: 'failed', error: 'The app is not running' }
          const scheduler = app.make(core.Scheduler)
          const task = scheduler.tasks().find(item => item.name === name)
          if (!task)
            return { status: 'failed', error: `Unknown scheduled task "${name}"` }
          const run = await scheduler.runTask(task)
          return {
            status: run.status,
            reason: run.reason,
            duration: run.duration,
            error: run.error === undefined
              ? undefined
              : (run.error as Error).message ?? String(run.error),
          }
        },
      })

      rpc.register({
        name: `${FRAME_ID}:openapi`,
        type: 'query',
        jsonSerializable: true,
        agent: {
          title: 'OpenAPI document',
          description: 'The OpenAPI 3.1 document of the running hazejs app (paths, parameters, request and response schemas). Use it to write API clients or tests against the current routes.',
        },
        handler: async () => {
          const app = source.app
          const path = snapshot()?.openapi?.path
          if (!app || !path)
            return null
          const response = await app.fetch(new Request(new URL(path, 'http://localhost')))
          return response.ok
            ? await response.json() as unknown
            : null
        },
      })
    },
  })
}

type CoreModule = typeof import('@hazejs/core')
interface AiModule {
  getModelRegistry: () => { defaults: { language?: string }, aliases: Record<string, string>, providers: Record<string, unknown> } | undefined
  generateText: (options: { model?: string, system?: string, prompt: string }) => Promise<{ text: string, usage: unknown, finishReason: string }>
}

/** 应用模块图中的 @hazejs/core（与应用共用类，app.make() 才能取到同一个实例） */
async function importCore(source: DevtoolsSource): Promise<CoreModule | undefined> {
  try {
    return await source.import?.<CoreModule>('@hazejs/core')
  }
  catch {
    return undefined
  }
}

async function importAi(source: DevtoolsSource): Promise<AiModule | undefined> {
  try {
    return await source.import?.<AiModule>('@hazejs/ai')
  }
  catch {
    return undefined
  }
}

async function queueCounts(source: DevtoolsSource): Promise<Array<{ connection: string, counts?: Record<string, number>, error?: string }>> {
  const app = source.app
  const core = await importCore(source)
  if (!app || !core)
    return []
  const queue = app.make(core.QueueManager)
  return Promise.all(Object.keys(queue.config.connections).map(async (connection) => {
    try {
      return { connection, counts: await queue.counts(connection) as Record<string, number> | undefined }
    }
    catch (error) {
      return { connection, error: (error as Error).message }
    }
  }))
}
