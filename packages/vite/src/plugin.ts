import type { IncomingMessage, ServerResponse } from 'node:http'
import type { EnvironmentModuleNode, Plugin, UserConfig } from 'vite'
import type { CloudflareOptions, Layout, PresetContext, PresetName } from './presets'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import process from 'node:process'
import { toNodeHandler } from 'srvx/node'
import { normalizePath } from 'vite'
import { loadThinkConfig } from './config'
import { PLUGIN_NAME, VIRTUAL_MODULES } from './constants'
import { createAppHost } from './host'
import { BUNDLE_ALL_EXCEPT_DRIVERS, DRIVER_PACKAGES, findInstalled, migrateEntryCode, projectDrivers, resolvePreset, scanExternals } from './presets'

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
  /** 开发时自动生成类型（默认读取 think.config.ts，否则为 true） */
  typegen?: boolean
  /** 部署预设，默认读取 THINK_PRESET 环境变量 / think.config.ts，否则为 node */
  preset?: PresetName
  /** 产物目录（默认读取 think.config.ts） */
  outDir?: string
  /** cloudflare 预设的 wrangler 配置（默认读取 think.config.ts） */
  cloudflare?: CloudflareOptions
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
  /** 解析后的目录与选项（config 钩子执行之后可用） */
  settings: () => Readonly<Pick<Settings, 'root' | 'srcDir' | 'typegen' | 'preset'>>
  /** 最近一次构建的结果（buildApp 完成后可用） */
  lastBuild: () => BuildInfo | undefined
}

export interface BuildInfo {
  preset: PresetName
  layout: Layout
  /** 运行时仍需从 node_modules 加载的依赖 */
  externals: string[]
  /** 服务端入口 */
  entry: string
  /** 生产迁移脚本（使用 @think-h3/orm 且为常驻进程型预设时） */
  migrate?: string
  /** 运行 / 部署提示 */
  hint: string
}

interface Settings {
  root: string
  srcDir: string
  outDir: string
  typegen: boolean
  port: number
  host: string | undefined
  prefixes: string[]
  fullstack: boolean
  preset: string
  orm: boolean
  cloudflare: CloudflareOptions | undefined
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
  const settings: Settings = {
    root: process.cwd(),
    srcDir: process.cwd(),
    outDir: resolve('dist'),
    typegen: true,
    port: 3000,
    host: undefined,
    prefixes: normalizePrefixes(options.prefix),
    fullstack: !options.standalone,
    preset: 'node',
    orm: false,
    cloudflare: undefined,
  }
  let lastBuild: BuildInfo | undefined
  let unsupported = new Set<string>()
  /** 全量打包时，未安装的驱动也替换为空模块（ORM 以字面量导入全部驱动） */
  let stubMissing = false
  const api: ThinkPluginApi = {
    onReload(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    settings: () => settings,
    lastBuild: () => lastBuild,
  }
  let isDev = true

  return {
    name: PLUGIN_NAME,
    api,

    async config(userConfig, env) {
      const base = normalizePath(resolve(userConfig.root ?? process.cwd()))
      // configResolved 之前预设就需要项目根目录（Vercel / Netlify 产物写在项目根下）
      settings.root = base
      // 显式传入 srcDir 时（如命令行已读取过 think.config.ts）不再重复读取
      const think = options.srcDir === undefined
        ? await loadThinkConfig(base)
        : undefined
      settings.srcDir = options.srcDir === undefined
        ? normalizePath(think?.srcDir ?? base)
        : normalizePath(isAbsolute(options.srcDir)
            ? options.srcDir
            : resolve(base, options.srcDir))
      settings.outDir = normalizePath(options.outDir ?? think?.outDir ?? resolve(base, 'dist'))
      settings.port = options.port ?? think?.port ?? 3000
      settings.host = options.host ?? think?.host
      settings.typegen = options.typegen ?? think?.typegen ?? true
      settings.preset = options.preset ?? process.env.THINK_PRESET ?? think?.preset ?? 'node'
      settings.cloudflare = options.cloudflare ?? think?.cloudflare
      settings.orm = Boolean(findInstalled('@think-h3/orm', base))

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
      // 构建时按部署预设决定产物布局、打包策略与入口；开发时不受影响
      if (env.command === 'build') {
        const preset = resolvePreset(settings.preset)
        const context = presetContext(settings)
        const layout = preset.layout(context)
        const migrateScript = Boolean(preset.migrateScript && settings.orm)
        config.environments = {
          ssr: {
            resolve: {
              ...(preset.conditions && { conditions: preset.conditions }),
              // 打包依赖：产物不依赖项目的 node_modules（框架包也无需发布）
              ...(preset.bundle === 'drivers-external' && { noExternal: BUNDLE_ALL_EXCEPT_DRIVERS }),
              ...(preset.bundle === 'all' && { noExternal: true }),
            },
            build: {
              outDir: layout.serverDir,
              emptyOutDir: true,
              target: preset.target ?? 'node22',
              sourcemap: true,
              rolldownOptions: {
                ...(preset.platform && { platform: preset.platform }),
                // 被替换为报错空模块的驱动没有具名导出；空模块在求值时即抛错，这些占位不会被使用
                ...(preset.unsupported?.length && { shimMissingExports: true }),
                ...(preset.external && { external: preset.external }),
                input: {
                  index: VIRTUAL_MODULES.serverEntry,
                  ...(migrateScript && { migrate: VIRTUAL_MODULES.migrateEntry }),
                },
                output: {
                  entryFileNames: '[name].mjs',
                  chunkFileNames: 'chunks/[name]-[hash].mjs',
                  ...(preset.singleFile && { codeSplitting: false }),
                },
              },
            },
          },
          ...(settings.fullstack && layout.clientDir && {
            client: {
              build: { outDir: layout.clientDir },
            },
          }),
        }
        unsupported = new Set(preset.unsupported)
        stubMissing = preset.bundle === 'all'
        config.builder = {
          async buildApp(builder) {
            // 先构建服务端：部分预设的前端目录位于服务端目录之内（emptyOutDir 不会误删）
            await builder.build(builder.environments.ssr)
            if (settings.fullstack)
              await builder.build(builder.environments.client)
            const externals = [
              ...new Set([
                // ORM 引用了全部驱动：只保留项目实际安装的
                ...scanExternals(layout.serverDir).filter(name => !DRIVER_PACKAGES.includes(name) || findInstalled(name, context.root)),
                ...(preset.bundle === 'drivers-external'
                  ? projectDrivers(context.root)
                  : []),
              ]),
            ].sort()
            const finalize = { ...context, layout, externals }
            await preset.finalize?.(finalize)
            lastBuild = {
              preset: preset.name,
              layout,
              externals,
              entry: join(layout.serverDir, 'index.mjs'),
              ...(migrateScript && {
                migrate: join(layout.serverDir, 'migrate.mjs'),
              }),
              hint: preset.hint(finalize),
            }
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

    resolveId: {
      // 先于 Vite 内置解析执行，才能拦截裸模块导入
      order: 'pre',
      async handler(id, importer) {
        if (virtualIds.has(id))
          return RESOLVED_PREFIX + id
        if (this.environment?.name !== 'ssr' || isDev)
          return
        const name = packageName(id)
        // 当前部署平台不支持的驱动：替换为调用即报错的空模块
        if (unsupported.has(name))
          return `${RESOLVED_PREFIX}think-unsupported:${id}`
        if (stubMissing && DRIVER_PACKAGES.includes(name) && !(await this.resolve(id, importer, { skipSelf: true })))
          return `${RESOLVED_PREFIX}think-missing:${id}`
      },
    },

    load(id) {
      if (!id.startsWith(RESOLVED_PREFIX))
        return
      if (id.startsWith(`${RESOLVED_PREFIX}think-unsupported:`)) {
        const name = id.slice(`${RESOLVED_PREFIX}think-unsupported:`.length)
        return `throw new Error(${JSON.stringify(`"${name}" is not supported on the "${settings.preset}" deployment preset`)})\nexport default undefined\n`
      }
      if (id.startsWith(`${RESOLVED_PREFIX}think-missing:`)) {
        const name = id.slice(`${RESOLVED_PREFIX}think-missing:`.length)
        return `throw new Error(${JSON.stringify(`"${name}" is not installed`)})\nexport default undefined\n`
      }
      switch (id.slice(RESOLVED_PREFIX.length)) {
        case VIRTUAL_MODULES.manifest:
          return manifestCode(settings, isDev)
        case VIRTUAL_MODULES.app:
          return appCode()
        case VIRTUAL_MODULES.serverEntry:
          return serverEntryCode(settings)
        case VIRTUAL_MODULES.migrations:
          return migrationsCode(settings)
        case VIRTUAL_MODULES.migrateEntry:
          return migrateEntryCode()
      }
    },

    hotUpdate({ type, file, modules }) {
      if (this.environment.name !== 'ssr')
        return
      // 生成的类型声明不触发重载
      if (file.startsWith(`${settings.root}/.think/`) || file.endsWith('.d.ts'))
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
    `const formatters = ${glob('app/response/Formatter.{ts,mts,js,mjs}', ', import: \'default\'')}`,
    `export const responseFormatter = Object.values(formatters)[0]`,
    `export const interceptors = ${glob('app/interceptor/*.{ts,mts,js,mjs}')}`,
    // 多应用：app/<name>/ 下的路由、配置、提供者、异常处理与响应格式（是否启用由 config/app.ts 的 apps 决定）
    `export const apps = ${glob('app/*/{route,config,provider,exception,response}/*.{ts,mts,js,mjs}')}`,
  ].join('\n')
}

/** database/ 下 drizzle-kit 生成的 SQL 与 journal，键为相对 srcDir 的路径（与 config/database.ts 的 migrations 一致） */
function migrationsCode(settings: Settings): string {
  const rel = normalizePath(relative(settings.root, settings.srcDir))
  const base = rel
    ? `/${rel}/`
    : '/'
  return `const raw = {
  ...import.meta.glob(${JSON.stringify(`${base}database/**/*.sql`)}, { query: '?raw', import: 'default', eager: true }),
  ...import.meta.glob(${JSON.stringify(`${base}database/**/meta/_journal.json`)}, { query: '?raw', import: 'default', eager: true }),
}
export const files = Object.fromEntries(Object.entries(raw).map(([path, content]) => [path.slice(${base.length}), content]))
`
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
    responseFormatter: manifest.responseFormatter,
    interceptors: manifest.interceptors,
    apps: manifest.apps,
    ...options,
  })
}
`
}

function presetContext(settings: Settings): PresetContext {
  return {
    root: settings.root,
    srcDir: settings.srcDir,
    orm: settings.orm,
    cloudflare: settings.cloudflare,
    outDir: settings.outDir,
    fullstack: settings.fullstack,
    prefixes: settings.prefixes,
    port: settings.port,
    host: settings.host,
  }
}

/** 生产入口由部署预设生成（监听端口 / Serverless handler / Worker） */
function serverEntryCode(settings: Settings): string {
  const preset = resolvePreset(settings.preset)
  const context = presetContext(settings)
  return preset.entry({
    ...context,
    layout: preset.layout(context),
  })
}

function normalizePrefixes(prefix: string | string[] | undefined): string[] {
  return (Array.isArray(prefix)
    ? prefix
    : [prefix ?? '/api'])
    .map(item => `/${item.replace(/^\/+|\/+$/g, '')}`)
}

function packageName(id: string): string {
  return id.split('/').slice(0, id.startsWith('@')
    ? 2
    : 1).join('/')
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
