import type { Application, ApplicationOptions } from '@think-h3/core'
import type { ViteDevServer } from 'vite'
import type { ReloadEvent, ThinkPluginApi } from './plugin'
import { relative } from 'node:path'
import { renderErrorPage } from '@think-h3/core'
import { consola } from 'consola'
import { createServerModuleRunner, normalizePath } from 'vite'
import { PLUGIN_NAME, VIRTUAL_MODULES } from './constants'
import { writeTypes } from './typegen'

export interface ReloadResult {
  ok: boolean
  /** 触发重载的文件（相对项目根），首次启动为 undefined */
  file?: string
  duration: number
  error?: unknown
}

export interface AppHostOptions {
  vite: ViteDevServer
  api: ThinkPluginApi
  /** 文件变化后的防抖时间，默认 30ms */
  debounce?: number
}

/**
 * 托管开发态应用：通过 Vite ModuleRunner 执行应用代码，文件变化时重新执行并原子替换。
 * 独立开发服务器（srvx）与 Vue 项目中的 Vite 中间件共用它。
 */
export interface AppHost {
  /** 当前正在服务的应用 */
  readonly app: Application | undefined
  /** 首次加载应用（幂等）；未调用时首个请求会自动触发 */
  start: () => Promise<ReloadResult>
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

interface AppModule {
  createApp: (options?: ApplicationOptions) => Promise<Application>
}

export function createAppHost({ vite, api, debounce = 30 }: AppHostOptions): AppHost {
  const root = vite.config.root
  const runner = createServerModuleRunner(vite.environments.ssr, { hmr: false })
  const listeners = new Set<(result: ReloadResult) => void>()
  let current: Slot | undefined
  let lastError: unknown
  let started: Promise<ReloadResult> | undefined
  let queue: Promise<ReloadResult> | undefined
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
      await generateTypes(app)
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

  async function generateTypes(app: Application): Promise<void> {
    const { srcDir, typegen } = api.settings()
    if (!typegen)
      return
    try {
      await writeTypes({
        root,
        srcDir,
        routes: app.router.list(),
      })
    }
    catch (error) {
      consola.warn(`[${PLUGIN_NAME}] failed to generate types`, error)
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

  function start(): Promise<ReloadResult> {
    started ??= reload()
    return started
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

  const unsubscribe = api.onReload((event: ReloadEvent) => {
    if (closed || !started)
      return
    const file = normalizePath(relative(root, event.file))
    clearTimeout(timer)
    timer = setTimeout(() => void reload(file), debounce)
  })

  async function fetch(request: Request): Promise<Response> {
    if (!started)
      await start()
    await started
    const slot = current
    if (!slot)
      return errorResponse(lastError, request, root)
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

  return {
    get app() {
      return current?.app
    },
    start,
    fetch,
    reload,
    onReload(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    async close() {
      if (closed)
        return
      closed = true
      unsubscribe()
      clearTimeout(timer)
      await queue
      await current?.app.dispose({ reason: 'shutdown' })
      current = undefined
      await runner.close()
    },
  }
}

/** 应用启动失败时的响应：浏览器显示错误页，其余返回 JSON */
function errorResponse(error: unknown, request: Request, rootDir: string): Response {
  const err = error instanceof Error
    ? error
    : new Error(String(error ?? 'Application is starting'))
  const message = `[${PLUGIN_NAME}] ${err.message}`
  if (request.headers.get('accept')?.includes('text/html')) {
    return new Response(renderErrorPage({
      error: err,
      status: 500,
      message,
      request,
      rootDir,
    }), {
      status: 500,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    })
  }
  return Response.json({
    code: 500,
    message,
    stack: err.stack?.split('\n').map(line => line.trim()),
  }, { status: 500 })
}
