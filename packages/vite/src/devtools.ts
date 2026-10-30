import type { Buffer } from 'node:buffer'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import type { AppHost } from './host'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { consola } from 'consola'
import { PLUGIN_NAME } from './constants'

export const DEVTOOLS_PACKAGE = '@hazejs/devtools'

/** `haze.config.ts` / `haze()` 的 devtools 选项 */
export interface DevtoolsConfig {
  /** 挂载路径，默认 `/__devtools/` */
  base?: string
  /** 浏览器首次连接时的一次性验证码，默认开启；只在本机单人开发时关闭 */
  auth?: boolean
  /** 终端面板，默认开启 */
  terminals?: boolean
  /** 全栈项目：在前端页面中注入悬浮的 DevTools 入口，默认开启 */
  embedded?: boolean
}

/** `@hazejs/devtools` 的 createDevtools 返回值（这里只声明用到的部分，避免依赖该包） */
export interface DevtoolsInstance {
  readonly base: string
  matches: (pathname: string) => boolean
  handler: (request: Request) => Promise<Response>
  nodeMiddleware: (req: IncomingMessage, res: ServerResponse, next?: (err?: unknown) => void) => void
  attach: (server: Server) => () => void
  handleUpgrade: (req: IncomingMessage, socket: Duplex, head: Buffer) => void
  close: () => Promise<void>
}

interface DevtoolsModule {
  createDevtools: (options: DevtoolsConfig & { source: AppHost, root: string, server?: Server }) => DevtoolsInstance
}

/**
 * 项目安装了 `@hazejs/devtools` 时创建 DevTools（只在开发服务器中调用，生产构建不会引入）。
 * 从项目根解析：@hazejs/vite 本身不依赖该包。
 */
export async function loadDevtools(
  root: string,
  config: boolean | DevtoolsConfig | undefined,
  options: { source: AppHost, server?: Server },
): Promise<DevtoolsInstance | undefined> {
  if (config === false)
    return undefined
  let entry: string
  try {
    entry = createRequire(join(root, 'package.json')).resolve(DEVTOOLS_PACKAGE)
  }
  catch {
    return undefined
  }
  try {
    const { createDevtools } = await import(pathToFileURL(entry).href) as DevtoolsModule
    return createDevtools({
      ...(typeof config === 'object'
        ? config
        : {}),
      ...options,
      root,
    })
  }
  catch (error) {
    consola.warn(`[${PLUGIN_NAME}] failed to start ${DEVTOOLS_PACKAGE}`, error)
    return undefined
  }
}

/** 请求路径（不含查询） */
export function pathnameOf(url: string | undefined): string {
  if (!url)
    return '/'
  return url.startsWith('/')
    ? url.split('?')[0]!
    : new URL(url).pathname
}
