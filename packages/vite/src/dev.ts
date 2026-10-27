import type { Application, ApplicationOptions } from '@think-h3/core'
import type { InlineConfig, ViteDevServer } from 'vite'
import type { ReloadEvent } from './plugin'
import { relative, resolve } from 'node:path'
import process from 'node:process'
import { consola } from 'consola'
import { serve } from 'srvx'
import { createServer, createServerModuleRunner, mergeConfig, normalizePath } from 'vite'
import { loadThinkConfig } from './config'
import { PLUGIN_NAME, VIRTUAL_MODULES } from './constants'
import { thinkH3 } from './plugin'

export interface DevServerOptions {
  /** 项目根目录，默认 `process.cwd()` */
  root?: string
  port?: number
  host?: string
  /** false 时不监听端口，只通过 `devServer.fetch()` 访问（测试 / 嵌入） */
  listen?: boolean
  /** 文件变化后的防抖时间，默认 30ms */
  debounce?: number
}

export interface ReloadResult {
  ok: boolean
  /** 触发重载的文件（相对项目根），首次启动为 undefined */
  file?: string
  duration: number
  error?: unknown
}

export interface DevServer {
  readonly url: string | undefined
  readonly vite: ViteDevServer
  /** 当前正在服务的应用 */
  readonly app: Application | undefined
  fetch: (request: Request) => Promise<Response>
  /** 手动触发一次重载 */
  reload: (file?: string) => Promise<ReloadResult>
  onReload: (listener: (result: ReloadResult) => void) => () => void
  close: () => Promise<void>
}

interface Slot {
  app: Application
  /** 进行中的请求数，旧应用等其归零后再释放 */
  active: number
  onIdle?: () => void
}

interface AppModule { createApp: (options?: ApplicationOptions) => Promise<Application> }

/**
 * 开发服务器：HTTP 监听只创建一次，文件变化时通过 Vite ModuleRunner 重新执行应用代码，
 * 原子替换 fetch 处理器——进程不重启、端口不断开。
 */
export async function createDevServer(options: DevServerOptions = {}): Promise<DevServer> {
  const root = resolve(options.root ?? process.cwd())
  const config = await loadThinkConfig(root)
  const plugin = thinkH3({ srcDir: config.srcDir, port: config.port, host: config.host })

  const vite = await createServer(mergeConfig(config.vite, {
    root,
    configFile: false,
    appType: 'custom',
    clearScreen: false,
    logLevel: 'warn',
    // .env 由框架自己加载；否则 Vite 会在 .env 变化时重启整个开发服务器
    envDir: false,
    server: {
      middlewareMode: true,
      // 纯后端无需 HMR WebSocket；文件变化仍会经过 hotUpdate 钩子
      ws: false,
      watch: {
        ignored: [`${normalizePath(config.outDir)}/**`],
      },
    },
    plugins: [plugin],
  } satisfies InlineConfig))

  const runner = createServerModuleRunner(vite.environments.ssr, { hmr: false })
  const listeners = new Set<(result: ReloadResult) => void>()
  let current: Slot | undefined
  let lastError: unknown
  let queue: Promise<ReloadResult> | undefined
  let pendingFile: string | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let closed = false

  async function load(file?: string): Promise<ReloadResult> {
    const start = performance.now()
    try {
      runner.clearCache()
      const { createApp } = await runner.import<AppModule>(VIRTUAL_MODULES.app)
      const app = await createApp({ mode: 'development' })
      const previous = current
      current = { app, active: 0 }
      lastError = undefined
      if (previous)
        void retire(previous)
      return { ok: true, file, duration: performance.now() - start }
    }
    catch (error) {
      lastError = error
      return {
        ok: false,
        file,
        duration: performance.now() - start,
        error,
      }
    }
  }

  async function retire(slot: Slot): Promise<void> {
    if (slot.active > 0)
      await new Promise<void>(resolve => (slot.onIdle = resolve))
    try {
      await slot.app.dispose({ reason: 'hmr' })
    }
    catch (error) {
      consola.warn(`[${PLUGIN_NAME}] failed to dispose previous app`, error)
    }
  }

  function reload(file?: string): Promise<ReloadResult> {
    // 串行执行：重载进行中又有变化时，在其后追加一次
    const run = async (): Promise<ReloadResult> => {
      const result = await load(file)
      report(result)
      return result
    }
    queue = (queue ?? Promise.resolve()).then(run, run) as Promise<ReloadResult>
    return queue
  }

  function report(result: ReloadResult): void {
    listeners.forEach(listener => listener(result))
    const ms = `${Math.round(result.duration)}ms`
    if (result.ok && result.file) {
      consola.success(`[${PLUGIN_NAME}] reloaded in ${ms} (${result.file})`)
    }
    else if (!result.ok) {
      consola.error(`[${PLUGIN_NAME}] ${result.file
        ? `reload failed (${result.file}), still serving the previous version`
        : 'failed to start'}\n`, result.error)
    }
  }

  plugin.api!.onReload((event: ReloadEvent) => {
    if (closed)
      return
    pendingFile = normalizePath(relative(root, event.file))
    clearTimeout(timer)
    timer = setTimeout(() => void reload(pendingFile), options.debounce ?? 30)
  })

  async function handle(request: Request): Promise<Response> {
    const slot = current
    if (!slot)
      return errorResponse(lastError)
    slot.active++
    try {
      return await slot.app.fetch(request)
    }
    finally {
      slot.active--
      if (slot.active === 0)
        slot.onIdle?.()
    }
  }

  const initial = await reload()
  if (!initial.ok && options.listen === false)
    consola.warn(`[${PLUGIN_NAME}] the app failed to start; requests will return the error until it is fixed`)

  const server = options.listen === false
    ? undefined
    : serve({
        fetch: handle,
        port: options.port ?? (Number(process.env.PORT) || config.port),
        hostname: options.host ?? config.host,
        silent: true,
        gracefulShutdown: false,
      })
  await server?.ready()

  return {
    get url() {
      return server?.url
    },
    vite,
    get app() {
      return current?.app
    },
    fetch: handle,
    reload,
    onReload(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    async close() {
      closed = true
      clearTimeout(timer)
      await server?.close(true)
      await queue
      await current?.app.dispose({ reason: 'shutdown' })
      current = undefined
      await runner.close()
      await vite.close()
    },
  }
}

function errorResponse(error: unknown): Response {
  const err = error instanceof Error
    ? error
    : new Error(String(error ?? 'Application is starting'))
  return Response.json({
    code: 500,
    message: `[${PLUGIN_NAME}] ${err.message}`,
    stack: err.stack?.split('\n').map(line => line.trim()),
  }, { status: 500 })
}
