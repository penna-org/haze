import type { TerminalPreset, TerminalsOptions } from '@devframes/plugin-terminals'
import type { Application } from '@hazejs/core'
import type { Buffer } from 'node:buffer'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import type { AppSnapshot, RouteRow } from './inspect'
import type { ReloadStatus } from './views'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { createUi } from '@devframes/hub-ui'
import { initHub } from '@devframes/hub/initiate'
import { jsonRenderUiRenderer } from '@devframes/json-render-ui/hub'
import { toJsonRenderDockEntry } from '@devframes/json-render/hub'
import { createJsonRenderView } from '@devframes/json-render/node'
import { createTerminalsDevframe } from '@devframes/plugin-terminals'
import { DASHBOARD_ICON, LOGO, OVERVIEW_ICON, ROUTES_ICON } from './icons'
import { filterRoutes, inspectApp } from './inspect'
import { errorSummary, errorText, overviewSpec, overviewState, ROUTES_FILTER_ACTION, routesSpec, routesState } from './views'

/** 默认挂载路径 */
export const DEVTOOLS_BASE = '/__devtools/'

/** 开发服务器托管的应用（@hazejs/vite 的 AppHost 满足该接口） */
export interface DevtoolsSource {
  /** 当前正在服务的应用；首次加载完成前为 undefined */
  readonly app: Application | undefined
  /** 每次（重新）加载应用后通知，加载失败时 ok 为 false */
  onReload: (listener: (result: ReloadStatus) => void) => () => void
}

export interface DevtoolsOptions {
  source: DevtoolsSource
  /** 项目根目录，默认 `process.cwd()`（终端的工作目录、devframe 的持久化目录） */
  root?: string
  /** 挂载路径，默认 `/__devtools/` */
  base?: string
  /** 共享该 http 服务器的 upgrade 事件（Vite 开发服务器）；不传时用 `attach` / `handleUpgrade` 接入 */
  server?: Server
  /**
   * 浏览器首次连接时的一次性验证码（打印在终端）。默认开启；
   * 只在本机、单人开发时可以关闭。
   */
  auth?: boolean
  /** 终端面板，默认开启；传对象覆盖 devframe 终端插件的选项 */
  terminals?: boolean | TerminalsOptions
}

export interface Devtools {
  /** 规范化后的挂载路径（前后都带 `/`） */
  readonly base: string
  /** 路径是否属于 devtools */
  matches: (pathname: string) => boolean
  handler: (request: Request) => Promise<Response>
  nodeMiddleware: (req: IncomingMessage, res: ServerResponse, next?: (err?: unknown) => void) => void
  /** 接管 http 服务器上 devtools 路径的 WebSocket 升级，返回卸载函数 */
  attach: (server: Server) => () => void
  handleUpgrade: (req: IncomingMessage, socket: Duplex, head: Buffer) => void
  ready: Promise<void>
  close: () => Promise<void>
}

const GROUP_ID = 'hazejs'
const RELOAD_MESSAGE = 'hazejs:reload'

/**
 * 创建 hazejs DevTools：基于 devframe hub，所有面板共用一个处理器、一条 WebSocket 与一次验证。
 * Hub 运行在开发服务器进程中，应用热替换时连接与面板状态保持不变，只刷新数据。
 */
export function createDevtools(options: DevtoolsOptions): Devtools {
  const root = options.root ?? process.cwd()
  const { source } = options
  const terminals = options.terminals ?? true

  const base = normalizeBase(options.base ?? DEVTOOLS_BASE)
  const ui = createUi({
    branding: {
      productName: 'hazejs DevTools',
      logo: LOGO,
      favicon: LOGO,
      primaryColor: '#6c5ce7',
    },
  })
  // hub 用应用的根地址生成验证链接；后端项目的根路径不是 DevTools，改为挂载路径
  const banner = ui.authBanner
  if (banner) {
    ui.authBanner = (info) => {
      const url = new URL(info.url)
      url.pathname = base
      banner({ ...info, url: url.href })
    }
  }

  const hub = initHub({
    name: 'hazejs-devtools',
    base,
    cwd: root,
    server: options.server,
    auth: options.auth ?? true,
    // 面板暂不向编码代理暴露（MCP 需要额外安装 @devframes/agentic）
    mcp: false,
    devframes: terminals
      ? [
          {
            devframe: createTerminalsDevframe({
              cwd: root,
              presets: hazePresets(root),
              ...(typeof terminals === 'object'
                ? terminals
                : {}),
            }),
            dock: { category: 'advanced' },
          },
        ]
      : [],
    renderers: [
      jsonRenderUiRenderer(),
    ],
    ui,
    configure(ctx) {
      let snapshot: AppSnapshot | undefined
      let reload: ReloadStatus | undefined
      let query = ''

      const overview = createJsonRenderView(ctx, {
        id: 'hazejs-overview',
        title: 'Overview',
        spec: overviewSpec(),
      })
      const routes = createJsonRenderView(ctx, {
        id: 'hazejs-routes',
        title: 'Routes',
        spec: routesSpec(),
      })

      ctx.docks.register({
        type: 'group',
        id: GROUP_ID,
        title: 'hazejs',
        icon: LOGO,
        category: 'framework',
        defaultChildId: 'hazejs:overview',
      })
      ctx.docks.register(toJsonRenderDockEntry(overview, {
        id: 'hazejs:overview',
        title: 'Overview',
        titleLocales: { 'zh-CN': '概览' },
        icon: OVERVIEW_ICON,
        groupId: GROUP_ID,
        defaultOrder: 10,
      }))
      const routesDock = ctx.docks.register(toJsonRenderDockEntry(routes, {
        id: 'hazejs:routes',
        title: 'Routes',
        titleLocales: { 'zh-CN': '路由' },
        icon: ROUTES_ICON,
        groupId: GROUP_ID,
        defaultOrder: 20,
      }))
      // /__haze 开发面板（请求、查询、队列、邮件……）由应用自己提供，这里以 iframe 嵌入
      const dashboardDock = ctx.docks.register({
        type: 'iframe',
        id: 'hazejs:dashboard',
        title: 'Dashboard',
        titleLocales: { 'zh-CN': '开发面板' },
        icon: DASHBOARD_ICON,
        groupId: GROUP_ID,
        defaultOrder: 30,
        url: '/__haze/',
        when: 'false',
      })

      ctx.rpc.register({
        name: ROUTES_FILTER_ACTION,
        type: 'action',
        jsonSerializable: true,
        handler: (params?: { query?: unknown }) => {
          query = typeof params?.query === 'string'
            ? params.query
            : ''
          renderRoutes()
        },
      })

      function patch(view: { patchState: (ops: any[]) => void }, state: Record<string, unknown>): void {
        view.patchState(Object.entries(state).map(([key, value]) => ({ op: 'replace', path: `/${key}`, value })))
      }

      function renderRoutes(): void {
        const all: RouteRow[] = snapshot?.routes ?? []
        patch(routes, routesState(all, filterRoutes(all, query)))
      }

      function refresh(): void {
        const app = source.app
        if (app) {
          try {
            snapshot = inspectApp(app)
          }
          catch (error) {
            void ctx.messages.add({ message: 'Failed to inspect the app', description: (error as Error).message, level: 'error' })
          }
        }
        patch(overview, overviewState(snapshot, reload))
        renderRoutes()
        routesDock.update({
          badge: snapshot
            ? String(snapshot.routes.length)
            : undefined,
        })
        dashboardDock.update(snapshot?.dashboard
          ? { url: `${snapshot.dashboard.path}/`, when: undefined }
          : { when: 'false' })
      }

      source.onReload((result) => {
        reload = result
        refresh()
        // 同一条消息：失败时出现 / 更新，恢复后移除
        if (result.ok) {
          void ctx.messages.remove(RELOAD_MESSAGE)
          return
        }
        void ctx.messages.add({
          id: RELOAD_MESSAGE,
          message: `Failed to reload the app${result.file
            ? ` (${result.file})`
            : ''}`,
          description: errorSummary(result.error),
          stacktrace: errorText(result.error),
          level: 'error',
        })
      })
      refresh()
    },
  })

  return {
    base: hub.base,
    matches: pathname => pathname === base.slice(0, -1) || pathname.startsWith(base),
    handler: hub.handler,
    nodeMiddleware: hub.nodeMiddleware,
    attach: hub.attach,
    handleUpgrade: hub.handleUpgrade,
    ready: hub.ready,
    close: hub.close,
  }
}

function normalizeBase(base: string): string {
  return `/${base.replace(/^\/+|\/+$/g, '')}/`
}

/** 终端面板中一键运行的 haze 命令 */
function hazePresets(root: string): TerminalPreset[] {
  const bin = join(root, 'node_modules', '.bin', process.platform === 'win32'
    ? 'haze.cmd'
    : 'haze')
  const command = existsSync(bin)
    ? bin
    : 'npx'
  const args = (...rest: string[]): string[] => command === 'npx'
    ? ['haze', ...rest]
    : rest
  return [
    {
      id: 'haze:route:list',
      title: 'haze route:list',
      command,
      args: args('route:list'),
      icon: 'ph:signpost-duotone',
    },
    {
      id: 'haze:module:list',
      title: 'haze module:list',
      command,
      args: args('module:list'),
      icon: 'ph:puzzle-piece-duotone',
    },
    {
      id: 'haze:schedule:list',
      title: 'haze schedule:list',
      command,
      args: args('schedule:list'),
      icon: 'ph:clock-duotone',
    },
    {
      id: 'haze:queue:work',
      title: 'haze queue:work',
      command,
      args: args('queue:work'),
      icon: 'ph:stack-duotone',
    },
  ]
}
