import type { TerminalPreset, TerminalsOptions } from '@devframes/plugin-terminals'
import type { Application } from '@hazejs/core'
import type { Buffer } from 'node:buffer'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import type { ReloadStatus } from './views'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { createUi } from '@devframes/hub-ui'
import { initHub } from '@devframes/hub/initiate'
import { jsonRenderUiRenderer } from '@devframes/json-render-ui/hub'
import { createTerminalsDevframe } from '@devframes/plugin-terminals'
import { createHazeFrame } from './frame'
import { LOGO } from './icons'
import { FRAME_DOCK, registerPanels } from './panels'

/** 默认挂载路径 */
export const DEVTOOLS_BASE = '/__devtools/'

/** 开发服务器托管的应用（@hazejs/vite 的 AppHost 满足该接口） */
export interface DevtoolsSource {
  /** 当前正在服务的应用；首次加载完成前为 undefined */
  readonly app: Application | undefined
  /** 每次（重新）加载应用后通知，加载失败时 ok 为 false */
  onReload: (listener: (result: ReloadStatus) => void) => () => void
  /**
   * 在应用的模块图中加载模块（与应用共用同一份 @hazejs/core 等）。
   * 执行定时任务、AI Playground 等需要应用内部类的操作依赖它；不提供时这些操作不可用。
   */
  import?: <T = any>(id: string) => Promise<T>
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
  /**
   * 向编码代理（Claude Code、Cursor 等）暴露 MCP 端点 `<base>__mcp`，默认开启。
   * 只接受本机连接；工具包括应用结构、路由、模块联动、请求时间线、AI 调用与 OpenAPI 文档。
   */
  mcp?: boolean
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

/**
 * 创建 hazejs DevTools：基于 devframe hub，所有面板共用一个处理器、一条 WebSocket 与一次验证。
 * Hub 运行在开发服务器进程中，应用热替换时连接与面板状态保持不变，只刷新数据。
 */
export function createDevtools(options: DevtoolsOptions): Devtools {
  const root = options.root ?? process.cwd()
  const { source } = options
  const terminals = options.terminals ?? true

  const base = normalizeBase(options.base ?? DEVTOOLS_BASE)
  const ui = createHazeUi()
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
    mcp: options.mcp === false
      ? false
      : {
          instructions: 'Tools for the running hazejs app in development. Call hazejs_snapshot first to learn its modules, routes, events and jobs; use hazejs_requests / hazejs_request to debug what a request did (queries, cache, events, jobs, AI calls).',
        },
    devframes: [
      {
        devframe: createHazeFrame({ source }),
        // SPA 的默认页面是模块联动图；其它页面在 configure 中以 iframe 面板注册
        dock: FRAME_DOCK,
      },
      ...(terminals
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
        : []),
    ],
    renderers: [
      jsonRenderUiRenderer(),
    ],
    ui,
    configure: ctx => registerPanels(ctx, { source, live: true }),
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

/** 带 hazejs 品牌的 hub 界面（实时 hub 与静态报告共用） */
export function createHazeUi(): ReturnType<typeof createUi> {
  return createUi({
    branding: {
      productName: 'hazejs DevTools',
      logo: LOGO,
      favicon: LOGO,
      primaryColor: '#6c5ce7',
    },
  })
}

export function normalizeBase(base: string): string {
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
