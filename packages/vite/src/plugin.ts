import type { Buffer } from 'node:buffer'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import type { EnvironmentModuleNode, Plugin, UserConfig } from 'vite'
import type { DevtoolsConfig, DevtoolsInstance, DevtoolsModule } from './devtools'
import type { AppHost, ReloadResult } from './host'
import type { ModulePackage } from './modules'
import type { CloudflareOptions, ExternalsOptions, Layout, PresetContext, PresetName, TraceResult, VercelOptions } from './presets'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import process from 'node:process'
import { nodeUpgradeHandler, registerNodeServer } from '@hazejs/core'
import { colors } from 'consola/utils'
import { toNodeHandler } from 'srvx/node'
import { normalizePath, transformWithOxc } from 'vite'
import { loadHazeConfig } from './config'
import { PLUGIN_NAME, VIRTUAL_MODULES } from './constants'
import { importDevtools, loadDevtools } from './devtools'
import { createAppHost } from './host'
import { findModulePackages, packagedMigrationFiles, rewriteMigrationUrls } from './modules'
import { bundleAllExcept, DRIVER_PACKAGES, externalPackages, externalPattern, findInstalled, migrateEntryCode, resolvePreset, scanExternals, traceDependencies, workerEntryCode } from './presets'
import { manifestFile, readBuildManifest, startPreview, staticDirOf, writeBuildManifest } from './preview'

export interface HazePluginOptions {
  /** 后端源码目录，相对 Vite root 或绝对路径；默认读取 haze.config.ts，否则为 `.` */
  srcDir?: string
  /** 交给后端处理的路径前缀（全栈模式），默认 `/api` */
  prefix?: string | string[]
  /** 指向 srcDir 的路径别名，默认 `~`；设为 false 关闭 */
  alias?: string | false
  /** 生产入口的默认端口 / 地址（运行时 PORT / HOST 环境变量优先） */
  port?: number
  host?: string
  /** 开发时自动生成类型（默认读取 haze.config.ts，否则为 true） */
  typegen?: boolean
  /** 部署预设，默认读取 HAZE_PRESET 环境变量 / haze.config.ts，否则为 node */
  preset?: PresetName
  /** 产物目录（默认读取 haze.config.ts） */
  outDir?: string
  /** cloudflare 预设的 wrangler 配置（默认读取 haze.config.ts） */
  cloudflare?: CloudflareOptions
  /** vercel 预设的选项（默认读取 haze.config.ts） */
  vercel?: VercelOptions
  /** 依赖的打包 / 追踪方式（默认读取 haze.config.ts） */
  externals?: ExternalsOptions
  /** 开发时的 DevTools（需安装 `@hazejs/devtools`；默认读取 haze.config.ts，否则开启） */
  devtools?: boolean | DevtoolsConfig
  /**
   * 不集成 Vite 开发服务器与前端构建（不挂载中间件、不配置 client / ssr 构建）。
   * 由 `haze dev / build` 与 `@hazejs/testing` 使用。
   */
  standalone?: boolean
}

export interface ReloadEvent {
  type: 'create' | 'update' | 'delete'
  file: string
}

export interface HazePluginApi {
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
  /** 追踪复制进产物 node_modules 的依赖 */
  traced: TraceResult | undefined
  /** 服务端入口 */
  entry: string
  /** 生产迁移脚本（使用 @hazejs/orm 且为常驻进程型预设时） */
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
  /** 依赖中的 hazejs 模块包 */
  modulePackages: ModulePackage[]
  cloudflare: CloudflareOptions | undefined
  vercel: VercelOptions | undefined
  externals: ExternalsOptions
  devtools: boolean | DevtoolsConfig
}

const RESOLVED_PREFIX = '\0'
const SOURCE_RE = /\.[cm]?[jt]sx?$/
/** 后端的 TSX / JSX 文件（视图）：用 @hazejs/core 的 JSX 运行时编译 */
const JSX_RE = /\.[jt]sx$/
/** 文件自己声明了 JSX 运行时（如在后端使用 React 渲染）时不处理 */
const JSX_PRAGMA_RE = /@jsx(?:ImportSource|Runtime)?\s/
const virtualIds = new Set<string>(Object.values(VIRTUAL_MODULES))

/**
 * hazejs 的 Vite 插件。
 *
 * - 纯后端项目：由 `hazejs` 命令行内部使用
 * - Vue 等前端项目：在 vite.config.ts 中加入 `haze()`，开发时把 `/api/**` 交给后端（同端口、热替换），
 *   `vite build` 一次产出 `dist/client` 与 `dist/server`
 */
export function haze(options: HazePluginOptions = {}): Plugin<HazePluginApi> {
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
    modulePackages: [],
    cloudflare: undefined,
    vercel: undefined,
    externals: {},
    devtools: true,
  }
  let lastBuild: BuildInfo | undefined
  let unsupported = new Set<string>()
  /** 全量打包时，未安装的驱动也替换为空模块（ORM 以字面量导入全部驱动） */
  let stubMissing = false
  const api: HazePluginApi = {
    onReload(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    settings: () => settings,
    lastBuild: () => lastBuild,
  }
  let isDev = true
  /** 全栈开发服务器上运行的 DevTools */
  let devtools: DevtoolsInstance | undefined
  /** Vite 配置开启了 `devtools`：hazejs 的面板注册进 Vite DevTools，不再单独启动 */
  let viteDevtools = false
  // 面板所需的应用来源：Vite DevTools 的 setup 可能早于 configureServer 中创建 AppHost，先绑定再转发
  let appHost: AppHost | undefined
  const reloadListeners = new Set<(result: ReloadResult) => void>()
  const devtoolsSource = {
    get app() {
      return appHost?.app
    },
    onReload(listener: (result: ReloadResult) => void): () => void {
      reloadListeners.add(listener)
      return () => reloadListeners.delete(listener)
    },
    import<T = any>(id: string): Promise<T> {
      return appHost
        ? appHost.import<T>(id)
        : Promise.reject(new Error('The app has not started yet'))
    },
  }
  // Vite DevTools 的插件钩子（@vitejs/devtools-kit 的 Plugin.devtools），只在开启 Vite DevTools 时调用
  const devtoolsHook = {
    devtools: {
      async setup(ctx: Parameters<DevtoolsModule['setupViteDevtools']>[0]) {
        if (!settings.fullstack || settings.devtools === false)
          return
        const module = await importDevtools(settings.root)
        await module?.setupViteDevtools(ctx, { source: devtoolsSource })
      },
    },
  } as Partial<Plugin>

  return {
    name: PLUGIN_NAME,
    api,
    ...devtoolsHook,

    async config(userConfig, env) {
      const base = normalizePath(resolve(userConfig.root ?? process.cwd()))
      // configResolved 之前预设就需要项目根目录（Vercel / Netlify 产物写在项目根下）
      settings.root = base
      // 显式传入 srcDir 时（如命令行已读取过 haze.config.ts）不再重复读取
      const fileConfig = options.srcDir === undefined
        ? await loadHazeConfig(base)
        : undefined
      settings.srcDir = options.srcDir === undefined
        ? normalizePath(fileConfig?.srcDir ?? base)
        : normalizePath(isAbsolute(options.srcDir)
            ? options.srcDir
            : resolve(base, options.srcDir))
      settings.outDir = normalizePath(options.outDir ?? fileConfig?.outDir ?? resolve(base, 'dist'))
      settings.port = options.port ?? fileConfig?.port ?? 3000
      settings.host = options.host ?? fileConfig?.host
      settings.typegen = options.typegen ?? fileConfig?.typegen ?? true
      settings.preset = options.preset ?? process.env.HAZE_PRESET ?? fileConfig?.preset ?? 'node'
      settings.cloudflare = options.cloudflare ?? fileConfig?.cloudflare
      settings.vercel = options.vercel ?? fileConfig?.vercel
      settings.externals = options.externals ?? fileConfig?.externals ?? {}
      settings.devtools = options.devtools ?? fileConfig?.devtools ?? true
      settings.orm = Boolean(findInstalled('@hazejs/orm', base))
      settings.modulePackages = findModulePackages(base)

      const config: UserConfig = {}
      // 链接进来的模块包（workspace / link:）在开发时由 Vite 处理，修改后热替换；已发布的模块包按普通依赖 external
      const linked = settings.modulePackages.filter(pkg => pkg.linked).map(pkg => pkg.name)
      if (env.command !== 'build' && linked.length)
        config.ssr = { noExternal: linked }
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
      // 预览：前端静态目录取自最近一次构建（CDN 托管静态资源的预设由 Vite 托管，其余由产物自己托管）
      if (env.isPreview) {
        const manifest = existsSync(manifestFile(base))
          ? readBuildManifest(base)
          : undefined
        if (manifest) {
          config.environments = {
            client: {
              build: { outDir: staticDirOf(manifest) ?? manifest.layout.clientDir ?? manifest.layout.serverDir },
            },
          }
        }
      }
      // 构建时按部署预设决定产物布局、打包策略与入口；开发时不受影响
      if (env.command === 'build') {
        const preset = resolvePreset(settings.preset)
        const context = presetContext(settings)
        const layout = preset.layout(context)
        const migrateScript = Boolean(preset.migrateScript && settings.orm)
        const trace = preset.trace === 'always' || (preset.trace === 'default' && settings.externals.trace !== false)
        // 关闭追踪时 node / bun 退回依赖全部 external（运行时使用项目的 node_modules）
        const bundle = !trace && preset.trace === 'default' && preset.name !== 'deno'
          ? 'external'
          : preset.bundle
        config.environments = {
          ssr: {
            resolve: {
              ...(preset.conditions && { conditions: preset.conditions }),
              ...(preset.mainFields && { mainFields: preset.mainFields }),
              // 打包依赖：产物不依赖项目的 node_modules（框架包也无需发布）
              ...(bundle === 'drivers-external' && {
                noExternal: bundleAllExcept(externalPackages(settings.externals)),
              }),
              ...(bundle === 'all' && { noExternal: true }),
              // 依赖保持 external 时，模块包仍然打包（与框架共用同一份 core，迁移目录可以内嵌）
              ...(bundle === 'external' && settings.modulePackages.length && {
                noExternal: settings.modulePackages.map(pkg => pkg.name),
              }),
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
                // drivers-external：驱动等包直接保留导入（未安装的可选驱动只在实际使用时才报错）
                ...((preset.external || bundle === 'drivers-external') && {
                  external: [
                    ...(preset.external ?? []),
                    ...(bundle === 'drivers-external'
                      ? [
                          externalPattern(externalPackages(settings.externals)),
                        ]
                      : []),
                  ],
                }),
                input: {
                  index: VIRTUAL_MODULES.serverEntry,
                  ...(migrateScript && { migrate: VIRTUAL_MODULES.migrateEntry }),
                  ...(preset.migrateScript && { worker: VIRTUAL_MODULES.workerEntry }),
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
        stubMissing = bundle === 'all'
        config.builder = {
          async buildApp(builder) {
            // 先构建服务端：部分预设的前端目录位于服务端目录之内（emptyOutDir 不会误删）
            await builder.build(builder.environments.ssr)
            if (settings.fullstack)
              await builder.build(builder.environments.client)
            // ORM 引用了全部驱动：只保留项目实际安装的
            const externals = scanExternals(layout.serverDir).filter(name => !DRIVER_PACKAGES.includes(name) || findInstalled(name, context.root))
            const traced = trace
              ? await traceDependencies(layout.serverDir, context.root, {
                  conditions: preset.conditions,
                  traceDeps: settings.externals.traceDeps,
                  platform: preset.runtimePlatform,
                })
              : undefined
            if (traced?.foreignNative.length) {
              builder.config.logger.warn(`[hazejs] ${preset.name} runs on ${preset.runtimePlatform}, but these native packages were traced from this ${process.platform} machine: ${traced.foreignNative.join(', ')}. Build on ${preset.runtimePlatform} (CI or Docker) so the right binaries are copied.`)
            }
            const finalize = {
              ...context,
              layout,
              externals,
              traced,
            }
            await preset.finalize?.(finalize)
            writeBuildManifest(settings.root, {
              preset: preset.name,
              layout,
              entry: join(layout.serverDir, 'index.mjs'),
              fullstack: settings.fullstack,
              prefixes: settings.prefixes,
            })
            lastBuild = {
              preset: preset.name,
              layout,
              externals,
              traced,
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
      viteDevtools = isDev && Boolean((config as { devtools?: unknown }).devtools)
    },

    async configureServer(server) {
      if (!settings.fullstack)
        return

      const host = createAppHost({ vite: server, api })
      appHost = host
      host.onReload(result => reloadListeners.forEach(listener => listener(result)))
      // DevTools 在 Vite 的 http 服务器上处理自己的 WebSocket（<base>__ws），中间件排在后端之前；
      // 开启了 Vite DevTools 时面板在其中显示（同样挂在 /__devtools/），不再重复启动
      devtools = viteDevtools
        ? undefined
        : await loadDevtools(settings.root, settings.devtools, {
            source: devtoolsSource,
            server: (server.httpServer ?? undefined) as never,
          })
      if (devtools) {
        server.middlewares.use(devtools.nodeMiddleware)
        const printUrls = server.printUrls.bind(server)
        server.printUrls = () => {
          printUrls()
          const local = server.resolvedUrls?.local[0]
          if (local)
            server.config.logger.info(`  ${colors.green('➜')}  ${colors.bold('DevTools')}: ${colors.cyan(new URL(devtools!.base.slice(1), local).href)}`)
        }
      }
      // Vite 的 connect 服务器是 HTTP/1；srvx 的类型同时覆盖 HTTP/2，这里按 HTTP/1 使用
      const handle = toNodeHandler(host.fetch) as unknown as (req: IncomingMessage, res: ServerResponse) => unknown
      // 框架内置的 /__haze/*（开发面板、存储签名链接）同样交给后端
      const matches = (url: string): boolean => [...settings.prefixes, '/__haze'].some(prefix =>
        url === prefix || url.startsWith(`${prefix}/`) || url.startsWith(`${prefix}?`))

      // 在 Vite 内置中间件之前注册，后端请求不会落入前端的静态资源 / SPA 回退
      server.middlewares.use((req, res, next) => {
        if (!req.url || !matches(req.url))
          return next()
        Promise.resolve(handle(req, res)).catch(next)
      })
      server.httpServer?.once('listening', () => void host.start())
      // WebSocket：后端前缀下的升级请求交给应用（Vite 自己的 HMR 连接带 vite-hmr 协议，互不影响）
      if (server.httpServer) {
        // 服务器扩展（如 Socket.IO）挂到 Vite 的 http 服务器
        registerNodeServer(server.httpServer as never)
        const upgrade = nodeUpgradeHandler(host.fetch)
        server.httpServer.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
          if (req.url && matches(req.url) && req.headers['sec-websocket-protocol'] !== 'vite-hmr')
            upgrade(req, socket, head)
        })
      }

      // Vite 关闭或重启（如 vite.config.ts / .env 变化）时释放应用
      const close = server.close.bind(server)
      server.close = async () => {
        await devtools?.close()
        devtools = undefined
        appHost = undefined
        await host.close()
        return close()
      }
    },

    // 在前端页面中注入悬浮的 DevTools 入口
    transformIndexHtml() {
      const embedded = typeof settings.devtools !== 'object' || settings.devtools.embedded !== false
      if (!devtools || !embedded)
        return
      return [
        {
          tag: 'script',
          attrs: { type: 'module', src: `${devtools.base}embedded.js` },
          injectTo: 'body',
        },
      ]
    },

    async configurePreviewServer(server) {
      const manifest = readBuildManifest(settings.root)
      const preview = await startPreview(settings.root, manifest, server.config.logger)
      server.config.logger.info(`  [hazejs] previewing the ${manifest.preset} build`)
      // 在 Vite 内置的静态资源中间件之前注册
      server.middlewares.use((req, res, next) => {
        if (!req.url || !preview.matches(req.url))
          return next()
        Promise.resolve(preview.handle(req, res)).catch(next)
      })
      if (preview.upgrade) {
        server.httpServer.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
          if (req.url && preview.matches(req.url))
            preview.upgrade!(req, socket, head)
        })
      }
      server.httpServer.once('close', () => void preview.close())
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
          return `${RESOLVED_PREFIX}haze-unsupported:${id}`
        if (stubMissing && DRIVER_PACKAGES.includes(name) && !(await this.resolve(id, importer, { skipSelf: true })))
          return `${RESOLVED_PREFIX}haze-missing:${id}`
      },
    },

    transform: {
      order: 'pre',
      async handler(code, id) {
        // 后端视图（srcDir 下的 .tsx / .jsx）：JSX 编译为 @hazejs/core/jsx-runtime 的调用。
        // 只作用于后端环境（client 环境即前端，React / Vue 等使用各自的 JSX 配置），先于 Vite 内置的 oxc 转换执行
        if (JSX_RE.test(id.split('?')[0]) && this.environment?.name !== 'client') {
          const file = normalizePath(id.split('?')[0])
          if (file.startsWith(`${settings.srcDir}/`) && !file.includes('/node_modules/') && !JSX_PRAGMA_RE.test(code)) {
            const result = await transformWithOxc(code, file, {
              lang: file.endsWith('.jsx')
                ? 'jsx'
                : 'tsx',
              jsx: { runtime: 'automatic', importSource: '@hazejs/core' },
              sourcemap: true,
            })
            return { code: result.code, map: result.map }
          }
        }
        // 生产构建：模块包中指向迁移目录的 new URL(..., import.meta.url) 改为内嵌迁移文件的键
        if (isDev || this.environment?.name !== 'ssr' || !settings.modulePackages.length || !code.includes('import.meta.url'))
          return
        const file = normalizePath(id.split('?')[0])
        const pkg = settings.modulePackages.find(item => file.startsWith(`${item.dir}/`))
        const rewritten = pkg && rewriteMigrationUrls(code, file, pkg)
        return rewritten
          ? { code: rewritten, map: null }
          : undefined
      },
    },

    load(id) {
      if (!id.startsWith(RESOLVED_PREFIX))
        return
      if (id.startsWith(`${RESOLVED_PREFIX}haze-unsupported:`)) {
        const name = id.slice(`${RESOLVED_PREFIX}haze-unsupported:`.length)
        return `throw new Error(${JSON.stringify(`"${name}" is not supported on the "${settings.preset}" deployment preset`)})\nexport default undefined\n`
      }
      if (id.startsWith(`${RESOLVED_PREFIX}haze-missing:`)) {
        const name = id.slice(`${RESOLVED_PREFIX}haze-missing:`.length)
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
        case VIRTUAL_MODULES.workerEntry:
          return workerEntryCode()
      }
    },

    hotUpdate({ type, file, modules }) {
      if (this.environment.name !== 'ssr')
        return
      // 生成的类型声明不触发重载
      if (file.startsWith(`${settings.root}/.haze/`) || file.endsWith('.d.ts'))
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
  const rel = srcDirFromRoot(settings)
  const base = rel
    ? `/${rel}`
    : ''
  const glob = (pattern: string, extra = ''): string =>
    `import.meta.glob(${JSON.stringify(`${base}/${pattern}`)}, { eager: true${extra} })`

  // 本地模块：键去掉 srcDir 前缀（/modules/<name>/...），按模块分组后文件名命名的规则不变
  const local = (pattern: string | string[], eager: boolean): string =>
    `strip(import.meta.glob(${JSON.stringify(([] as string[]).concat(pattern).map(item => `${base}/modules/*/${item}`))}${eager
      ? ', { eager: true }'
      : ''}))`
  const sources = '{ts,mts,js,mjs}'
  return [
    // 开发态从项目根加载 .env；生产态使用运行时工作目录
    `export const rootDir = ${dev
      ? JSON.stringify(settings.root)
      : 'undefined'}`,
    // 后端源码目录（本地模块迁移等相对路径的基准）；生产态迁移已内嵌，使用工作目录
    `export const srcDir = ${dev
      ? JSON.stringify(settings.srcDir)
      : 'undefined'}`,
    `const strip = record => Object.fromEntries(Object.entries(record).map(([key, value]) => [key.slice(${base.length}), value]))`,
    `export const config = ${glob('config/*.{ts,mts,js,mjs}')}`,
    `export const routes = ${glob('route/*.{ts,mts,js,mjs}')}`,
    `export const providers = ${glob('app/provider/*.{ts,mts,js,mjs}')}`,
    `const handlers = ${glob('app/exception/Handler.{ts,mts,js,mjs}', ', import: \'default\'')}`,
    `export const exceptionHandler = Object.values(handlers)[0]`,
    `const formatters = ${glob('app/response/Formatter.{ts,mts,js,mjs}', ', import: \'default\'')}`,
    `export const responseFormatter = Object.values(formatters)[0]`,
    `export const interceptors = ${glob('app/interceptor/*.{ts,mts,js,mjs}')}`,
    `export const policies = ${glob('app/policy/*.{ts,mts,js,mjs}')}`,
    `export const jobs = ${glob('app/job/*.{ts,mts,js,mjs}')}`,
    `export const schedules = ${glob('schedule/*.{ts,mts,js,mjs}')}`,
    `export const events = ${glob('app/event/*.{ts,mts,js,mjs}')}`,
    `export const listeners = ${glob('app/listener/*.{ts,mts,js,mjs}')}`,
    // 扩展包读取的目录（app.discovered(name)）。
    // commands 按需加载（Web 进程不执行命令代码），含子目录（db/Cleanup.ts → db:cleanup），由命令行与 worker.mjs 读取
    `export const discovered = { sockets: ${glob('app/socket/*.{ts,mts,js,mjs}')}, messages: ${glob('app/message/*.{ts,mts,js,mjs}')}, channels: ${glob('app/channel/*.{ts,mts,js,mjs}')}, notifications: ${glob('app/notification/*.{ts,mts,js,mjs}')}, commands: import.meta.glob(${JSON.stringify(`${base}/app/command/**/*.{ts,mts,js,mjs}`)}) }`,
    // 视图：app/view/**/*.tsx（按需加载，view('Name') 与维护页的 render 使用）
    `export const views = import.meta.glob(${JSON.stringify(`${base}/app/view/**/*.{tsx,jsx,ts,mts,js,mjs}`)})`,
    // 翻译文件：lang/<locale>/*.ts
    `export const lang = ${glob('lang/**/*.{ts,mts,js,mjs,json}')}`,
    // 多应用：app/<name>/ 下的路由、配置、提供者、异常处理与响应格式（是否启用由 config/app.ts 的 apps 决定）
    `export const apps = ${glob('app/*/{route,config,provider,exception,response}/*.{ts,mts,js,mjs}')}`,
    // 本地模块 modules/<name>/：与项目相同的目录约定；命令按需加载
    `export const modules = { ...${local([
      `module.${sources}`,
      `{route,config,schedule}/*.${sources}`,
      `app/{provider,interceptor,policy,job,event,listener,notification,channel,socket,message}/*.${sources}`,
    ], true)}, ...${local(`app/command/**/*.${sources}`, false)} }`,
  ].join('\n')
}

/** database/ 下 drizzle-kit 生成的 SQL 与 journal，键为相对 srcDir 的路径（与 config/database.ts 的 migrations 一致） */
function migrationsCode(settings: Settings): string {
  const rel = srcDirFromRoot(settings)
  const base = rel
    ? `/${rel}/`
    : '/'
  // 模块包的迁移（node_modules/<包名>/...，见 rewriteMigrationUrls）在构建时读取并内嵌
  return `const raw = {
  ...import.meta.glob(${JSON.stringify([`${base}database/**/*.sql`, `${base}modules/*/database/**/*.sql`])}, { query: '?raw', import: 'default', eager: true }),
  ...import.meta.glob(${JSON.stringify([`${base}database/**/meta/_journal.json`, `${base}modules/*/database/**/meta/_journal.json`])}, { query: '?raw', import: 'default', eager: true }),
}
export const files = {
  ...Object.fromEntries(Object.entries(raw).map(([path, content]) => [path.slice(${base.length}), content])),
  ...${JSON.stringify(packagedMigrationFiles(settings.modulePackages))},
}
`
}

function appCode(): string {
  return `
import { createApplication } from '@hazejs/core'
import * as manifest from '${VIRTUAL_MODULES.manifest}'

export { manifest }

export function createApp(options = {}) {
  return createApplication({
    rootDir: manifest.rootDir,
    srcDir: manifest.srcDir,
    config: manifest.config,
    routes: manifest.routes,
    providers: manifest.providers,
    exceptionHandler: manifest.exceptionHandler,
    responseFormatter: manifest.responseFormatter,
    interceptors: manifest.interceptors,
    policies: manifest.policies,
    jobs: manifest.jobs,
    schedules: manifest.schedules,
    events: manifest.events,
    listeners: manifest.listeners,
    discovered: manifest.discovered,
    lang: manifest.lang,
    apps: manifest.apps,
    localModules: manifest.modules,
    views: manifest.views,
    ...options,
  })
}
`
}

function presetContext(settings: Settings): PresetContext {
  return {
    root: settings.root,
    externalsOptions: settings.externals,
    srcDir: settings.srcDir,
    orm: settings.orm,
    cloudflare: settings.cloudflare,
    vercel: settings.vercel,
    schedules: hasSources(join(settings.srcDir, 'schedule')) || subdirs(join(settings.srcDir, 'modules')).some(dir => hasSources(join(dir, 'schedule'))),
    websocket: settings.cloudflare?.websocket ?? usesWebSocket(settings.srcDir),
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

/** 后端源码目录相对项目根的路径（相同时为空字符串；normalizePath('') 会得到 '.'） */
function srcDirFromRoot(settings: Settings): string {
  const rel = normalizePath(relative(settings.root, settings.srcDir))
  return rel === '.'
    ? ''
    : rel
}

/** 路由文件中是否定义了 WebSocket（r.ws(...)） */
function usesWebSocket(srcDir: string): boolean {
  const dirs = [
    join(srcDir, 'route'),
    ...subdirs(join(srcDir, 'app')).map(dir => join(dir, 'route')),
    ...subdirs(join(srcDir, 'modules')).map(dir => join(dir, 'route')),
  ]
  return dirs.some(dir => existsSync(dir) && readdirSync(dir).some(name => SOURCE_RE.test(name) && /\.ws\s*\(/.test(readFileSync(join(dir, name), 'utf8'))))
}

/** 目录下的子目录（app/<name>、modules/<name>） */
function subdirs(dir: string): string[] {
  return existsSync(dir)
    ? readdirSync(dir, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => join(dir, entry.name))
    : []
}

/** 目录下是否有源码文件（如 schedule/*.ts） */
function hasSources(dir: string): boolean {
  return existsSync(dir) && readdirSync(dir).some(name => SOURCE_RE.test(name) && !name.endsWith('.d.ts'))
}

function packageName(id: string): string {
  return id.split('/').slice(0, id.startsWith('@')
    ? 2
    : 1).join('/')
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
