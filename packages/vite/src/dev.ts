import type { Application } from '@think-h3/core'
import type { InlineConfig, ViteDevServer } from 'vite'
import type { ReloadResult } from './host'
import { resolve } from 'node:path'
import process from 'node:process'
import { webSocketConfig, webSocketPlugin } from '@think-h3/core'
import { consola } from 'consola'
import { serve } from 'srvx'
import { createServer, mergeConfig, normalizePath } from 'vite'
import { loadThinkConfig } from './config'
import { PLUGIN_NAME } from './constants'
import { createAppHost } from './host'
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

export interface DevServer {
  readonly url: string | undefined
  readonly vite: ViteDevServer
  /** 当前正在服务的应用 */
  readonly app: Application | undefined
  fetch: (request: Request) => Promise<Response>
  /** 手动触发一次重载 */
  reload: (file?: string) => Promise<ReloadResult>
  onReload: (listener: (result: ReloadResult) => void) => () => void
  /** 在应用的模块图中执行模块（命令行的 db:migrate / db:seed 使用） */
  import: <T = any>(id: string) => Promise<T>
  close: () => Promise<void>
}

/**
 * 纯后端项目的开发服务器：HTTP 监听只创建一次，文件变化时通过 Vite ModuleRunner
 * 重新执行应用代码并原子替换 fetch 处理器——进程不重启、端口不断开。
 */
export async function createDevServer(options: DevServerOptions = {}): Promise<DevServer> {
  const root = resolve(options.root ?? process.cwd())
  const config = await loadThinkConfig(root)
  const plugin = thinkH3({
    srcDir: config.srcDir,
    port: config.port,
    host: config.host,
    typegen: config.typegen,
    standalone: true,
  })

  const vite = await createServer(mergeConfig(config.vite, {
    root,
    configFile: false,
    appType: 'custom',
    clearScreen: false,
    logLevel: 'warn',
    // .env 由框架自己加载；否则 Vite 会在 .env 变化时重启整个开发服务器
    envDir: false,
    // 只运行后端代码，不需要扫描 / 预构建前端依赖（全栈项目里也不会去解析 index.html）
    optimizeDeps: { noDiscovery: true, entries: [] },
    server: {
      middlewareMode: true,
      // 纯后端无需 HMR WebSocket；文件变化仍会经过 hotUpdate 钩子
      ws: false,
      watch: {
        // 构建产物与生成的类型不触发重载
        ignored: [`${normalizePath(config.outDir)}/**`, `${normalizePath(root)}/.think/**`],
      },
    },
    plugins: [plugin],
  } satisfies InlineConfig))

  const host = createAppHost({ vite, api: plugin.api!, debounce: options.debounce })
  const initial = await host.start()
  if (!initial.ok && options.listen === false)
    consola.warn(`[${PLUGIN_NAME}] the app failed to start; requests will return the error until it is fixed`)

  const server = options.listen === false
    ? undefined
    : serve({
        fetch: host.fetch,
        port: options.port ?? (Number(process.env.PORT) || config.port),
        hostname: options.host ?? config.host,
        silent: true,
        gracefulShutdown: false,
        // WebSocket：每个新连接从热替换后的最新应用解析钩子
        plugins: [
          webSocketPlugin(host.fetch, host.app
            ? webSocketConfig(host.app.config)
            : undefined),
        ],
      })
  await server?.ready()

  return {
    get url() {
      return server?.url
    },
    vite,
    get app() {
      return host.app
    },
    fetch: host.fetch,
    reload: host.reload,
    onReload: host.onReload,
    import: host.import,
    async close() {
      await server?.close(true)
      await host.close()
      await vite.close()
    },
  }
}
