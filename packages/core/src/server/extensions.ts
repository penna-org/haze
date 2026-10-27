import type { Server as NodeServer } from 'node:http'
import { globalStore } from '../utils'

/** Bun 的 ServerWebSocket（只用到的部分） */
export interface BunSocketLike {
  data: unknown
}

export interface BunExtension {
  /** 处理本扩展路径下的请求（含 WebSocket 升级），server 为 Bun.Server */
  handle: (request: Request, server: unknown) => Response | Promise<Response>
  /** 该连接是否由本扩展升级（按 ws.data 判断） */
  owns: (ws: BunSocketLike) => boolean
  websocket: {
    open?: (ws: never) => void
    message?: (ws: never, message: never) => void
    close?: (ws: never, code: number, reason: string) => void
    drain?: (ws: never) => void
  }
  /** 长轮询等需要的 Bun.serve idleTimeout（秒） */
  idleTimeout?: number
}

/**
 * 服务器扩展：在框架创建的 HTTP 服务器上挂载其它协议（如 Socket.IO）。
 * Node：拿到 http.Server 自行 attach；Bun：在应用之前处理匹配的请求，并接管自己升级的 WebSocket。
 * 匹配的路径不再交给应用与 crossws（r.ws）。
 */
export interface ServerExtension {
  /** 同名扩展重复注册时替换（开发时热替换） */
  name: string
  matches: (pathname: string) => boolean
  node?: (server: NodeServer) => void
  bun?: BunExtension
}

/** 挂载时新增 / 替换的监听器，卸载时恢复 */
interface Attachment {
  extension: ServerExtension
  request: Array<(...args: any[]) => void>
  upgrade: Array<(...args: any[]) => void>
}

interface Registry {
  extensions: Map<string, ServerExtension>
  servers: Set<NodeServer>
  attached: WeakMap<NodeServer, Map<string, Attachment>>
}

const registry = globalStore<Registry>('server:extensions', () => ({
  extensions: new Map(),
  servers: new Set(),
  attached: new WeakMap(),
}))

function attach(server: NodeServer, extension: ServerExtension): void {
  if (!extension.node)
    return
  const attachments = registry.attached.get(server) ?? new Map<string, Attachment>()
  registry.attached.set(server, attachments)
  const previous = attachments.get(extension.name)
  if (previous?.extension === extension)
    return
  if (previous)
    detach(server, extension.name)
  // 记录挂载前的监听器：engine.io 等会替换 request 监听器并增加 upgrade 监听器
  const request = server.listeners('request') as Attachment['request']
  const upgrade = server.listeners('upgrade') as Attachment['upgrade']
  extension.node(server)
  attachments.set(extension.name, { extension, request, upgrade })
}

/** 卸载扩展：恢复挂载前的 request 监听器，移除它增加的 upgrade 监听器 */
function detach(server: NodeServer, name: string): void {
  const attachment = registry.attached.get(server)?.get(name)
  if (!attachment)
    return
  registry.attached.get(server)!.delete(name)
  server.removeAllListeners('request')
  attachment.request.forEach(listener => server.on('request', listener))
  for (const listener of server.listeners('upgrade') as Attachment['upgrade']) {
    if (!attachment.upgrade.includes(listener))
      server.removeListener('upgrade', listener)
  }
}

/** 注册扩展：立即挂到已知的 Node 服务器，之后创建的服务器也会挂上；同名扩展会先卸载旧的 */
export function registerServerExtension(extension: ServerExtension): void {
  registry.extensions.set(extension.name, extension)
  registry.servers.forEach(server => attach(server, extension))
}

/** 注销扩展并从所有服务器卸载（如 socket.io 实例关闭时） */
export function unregisterServerExtension(name: string, extension?: ServerExtension): void {
  if (extension && registry.extensions.get(name) !== extension)
    return
  registry.extensions.delete(name)
  registry.servers.forEach(server => detach(server, name))
}

/** @internal */
export function registerNodeServer(server: NodeServer): void {
  registry.servers.add(server)
  server.once('close', () => registry.servers.delete(server))
  registry.extensions.forEach(extension => attach(server, extension))
}

export function serverExtensions(): ServerExtension[] {
  return [
    ...registry.extensions.values(),
  ]
}

/** 路径是否由扩展处理 */
export function extensionFor(url: string | undefined): ServerExtension | undefined {
  if (!url)
    return undefined
  const pathname = url.startsWith('/')
    ? url.split('?')[0]
    : new URL(url).pathname
  return serverExtensions().find(extension => extension.matches(pathname))
}
