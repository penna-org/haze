import type { IncomingMessage, ServerResponse } from 'node:http'
import type { EnvironmentModuleNode, Plugin, UserConfig } from 'vite'
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path'
import process from 'node:process'
import { toNodeHandler } from 'srvx/node'
import { normalizePath } from 'vite'
import { loadThinkConfig } from './config'
import { PLUGIN_NAME, VIRTUAL_MODULES } from './constants'
import { createAppHost } from './host'

export interface ThinkPluginOptions {
  /** 后端源码目录，相对 Vite root 或绝对路径；默认读取 think.config.ts，否则为 `.` */
  srcDir?: string
  /** 交给后端处理的路径前缀（全栈模式），默认 `/api` */
  prefix?: string | string[]
  /** 指向 srcDir 的路径别名，默认 `~`；设为 false 关闭 */
  alias?: string | false
  /** 生产入口的默认端口 / 地址（运行时 PORT / HOST 环境变量优先） */
  port?: number
  host?: string
  /**
   * 不集成 Vite 开发服务器与前端构建（不挂载中间件、不配置 client / ssr 构建）。
   * 由 `think-h3 dev / build` 与 `@think-h3/testing` 使用。
   */
  standalone?: boolean
}

export interface ReloadEvent {
  type: 'create' | 'update' | 'delete'
  file: string
}

export interface ThinkPluginApi {
  /** 后端相关文件变化时通知（开发服务器据此热替换应用） */
  onReload: (listener: (event: ReloadEvent) => void) => () => void
}

interface Settings {
  root: string
  srcDir: string
  outDir: string
  port: number
  host: string | undefined
  prefixes: string[]
  fullstack: boolean
}

const RESOLVED_PREFIX = '\0'
const SOURCE_RE = /\.[cm]?[jt]s$/
const virtualIds = new Set<string>(Object.values(VIRTUAL_MODULES))

/**
 * think-h3 的 Vite 插件。
 *
 * - 纯后端项目：由 `think-h3` 命令行内部使用
 * - Vue 等前端项目：在 vite.config.ts 中加入 `thinkH3()`，开发时把 `/api/**` 交给后端（同端口、热替换），
 *   `vite build` 一次产出 `dist/client` 与 `dist/server`
 */
export function thinkH3(options: ThinkPluginOptions = {}): Plugin<ThinkPluginApi> {
  const listeners = new Set<(event: ReloadEvent) => void>()
  const api: ThinkPluginApi = {
    onReload(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
  const settings: Settings = {
    root: process.cwd(),
    srcDir: process.cwd(),
    outDir: resolve('dist'),
    port: 3000,
    host: undefined,
    prefixes: normalizePrefixes(options.prefix),
    fullstack: !options.standalone,
  }
  let isDev = true

  return {
    name: PLUGIN_NAME,
    api,

    async config(userConfig) {
      const base = normalizePath(resolve(userConfig.root ?? process.cwd()))
      // 显式传入 srcDir 时（如命令行已读取过 think.config.ts）不再重复读取
      const think = options.srcDir === undefined
        ? await loadThinkConfig(base)
        : undefined
      settings.srcDir = options.srcDir === undefined
        ? normalizePath(think?.srcDir ?? base)
        : normalizePath(isAbsolute(options.srcDir)
            ? options.srcDir
            : resolve(base, options.srcDir))
      settings.outDir = normalizePath(think?.outDir ?? resolve(base, 'dist'))
      settings.port = options.port ?? think?.port ?? 3000
      settings.host = options.host ?? think?.host

      const config: UserConfig = {}
      if (options.alias !== false) {
        config.resolve = {
          alias: [
            {
              find: new RegExp(`^${escapeRegExp(options.alias ?? '~')}/`),
              replacement: `${settings.srcDir}/`,
            },
          ],
        }
      }
      if (settings.fullstack) {
        config.environments = {
          client: {
            build: { outDir: `${settings.outDir}/client` },
          },
          ssr: {
            build: {
              outDir: `${settings.outDir}/server`,
              emptyOutDir: true,
              target: 'node22',
              sourcemap: true,
              rolldownOptions: {
                input: { index: VIRTUAL_MODULES.serverEntry },
                output: { entryFileNames: '[name].mjs', chunkFileNames: 'chunks/[name]-[hash].mjs' },
              },
            },
          },
        }
        // `vite build` 依次构建前端与后端
        config.builder = {
          async buildApp(builder) {
            await builder.build(builder.environments.client)
            await builder.build(builder.environments.ssr)
          },
        }
      }
      return config
    },

    configResolved(config) {
      settings.root = normalizePath(config.root)
      isDev = config.command === 'serve'
    },

    configureServer(server) {
      if (!settings.fullstack)
        return

      const host = createAppHost({ vite: server, api })
      // Vite 的 connect 服务器是 HTTP/1；srvx 的类型同时覆盖 HTTP/2，这里按 HTTP/1 使用
      const handle = toNodeHandler(host.fetch) as unknown as (req: IncomingMessage, res: ServerResponse) => unknown
      const matches = (url: string): boolean => settings.prefixes.some(prefix =>
        url === prefix || url.startsWith(`${prefix}/`) || url.startsWith(`${prefix}?`))

      // 在 Vite 内置中间件之前注册，后端请求不会落入前端的静态资源 / SPA 回退
      server.middlewares.use((req, res, next) => {
        if (!req.url || !matches(req.url))
          return next()
        Promise.resolve(handle(req, res)).catch(next)
      })
      server.httpServer?.once('listening', () => void host.start())

      // Vite 关闭或重启（如 vite.config.ts / .env 变化）时释放应用
      const close = server.close.bind(server)
      server.close = async () => {
        await host.close()
        return close()
      }
    },

    resolveId(id) {
      if (virtualIds.has(id))
        return RESOLVED_PREFIX + id
    },

    load(id) {
      if (!id.startsWith(RESOLVED_PREFIX))
        return
      switch (id.slice(RESOLVED_PREFIX.length)) {
        case VIRTUAL_MODULES.manifest:
          return manifestCode(settings, isDev)
        case VIRTUAL_MODULES.app:
          return appCode()
        case VIRTUAL_MODULES.serverEntry:
          return serverEntryCode(settings)
      }
    },

    hotUpdate({ type, file, modules }) {
      if (this.environment.name !== 'ssr')
        return

      const isEnvFile = dirname(file) === settings.root && basename(file).startsWith('.env')
      const isNewSource = type !== 'update' && file.startsWith(`${settings.srcDir}/`) && SOURCE_RE.test(file)
      if (!modules.length && !isEnvFile && !isNewSource)
        return

      // 新增 / 删除文件时重新生成 glob 清单
      if (type !== 'update') {
        const manifest = this.environment.moduleGraph.getModuleById(RESOLVED_PREFIX + VIRTUAL_MODULES.manifest)
        if (manifest)
          this.environment.moduleGraph.invalidateModule(manifest)
      }

      listeners.forEach(listener => listener({ type, file }))
      // 由 AppHost 整体重载应用，阻止 Vite 默认的 SSR 处理（不影响 client 环境的 HMR）
      return [] as EnvironmentModuleNode[]
    },
  }
}

function manifestCode(settings: Settings, dev: boolean): string {
  const rel = normalizePath(relative(settings.root, settings.srcDir))
  const base = rel
    ? `/${rel}`
    : ''
  const glob = (pattern: string, extra = ''): string =>
    `import.meta.glob(${JSON.stringify(`${base}/${pattern}`)}, { eager: true${extra} })`

  return [
    // 开发态从项目根加载 .env；生产态使用运行时工作目录
    `export const rootDir = ${dev
      ? JSON.stringify(settings.root)
      : 'undefined'}`,
    `export const config = ${glob('config/*.{ts,mts,js,mjs}')}`,
    `export const routes = ${glob('route/*.{ts,mts,js,mjs}')}`,
    `export const providers = ${glob('app/provider/*.{ts,mts,js,mjs}')}`,
    `const handlers = ${glob('app/exception/Handler.{ts,mts,js,mjs}', ', import: \'default\'')}`,
    `export const exceptionHandler = Object.values(handlers)[0]`,
  ].join('\n')
}

function appCode(): string {
  return `
import { createApplication } from '@think-h3/core'
import * as manifest from '${VIRTUAL_MODULES.manifest}'

export { manifest }

export function createApp(options = {}) {
  return createApplication({
    rootDir: manifest.rootDir,
    config: manifest.config,
    routes: manifest.routes,
    providers: manifest.providers,
    exceptionHandler: manifest.exceptionHandler,
    ...options,
  })
}
`
}

function serverEntryCode(settings: Settings): string {
  // 全栈模式：同一进程托管 dist/client，前端路由回退到 index.html
  const staticOption = settings.fullstack
    ? `static: { dir: fileURLToPath(new URL('../client', import.meta.url)), spaFallback: true, exclude: ${JSON.stringify(settings.prefixes)} },`
    : ''
  return `
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { createApp } from '${VIRTUAL_MODULES.app}'

const app = await createApp({ mode: 'production', ${staticOption} })
app.serve({
  port: Number(process.env.PORT) || ${settings.port},
  hostname: process.env.HOST || ${JSON.stringify(settings.host ?? '0.0.0.0')},
})
`
}

function normalizePrefixes(prefix: string | string[] | undefined): string[] {
  return (Array.isArray(prefix)
    ? prefix
    : [prefix ?? '/api'])
    .map(item => `/${item.replace(/^\/+|\/+$/g, '')}`)
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
