import type { MiddlewareHandler } from '../types'
import { CacheManager } from '../../cache/manager'
import { markBuffered } from '../../http/response'
import { I18nManager } from '../../i18n/manager'
import { parseDuration } from '../../utils'

interface CachedResponse {
  status: number
  headers: [string, string][]
  /** base64 */
  body: string
  storedAt: number
}

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes)
    binary += String.fromCharCode(byte)
  return btoa(binary)
}

function fromBase64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), char => char.charCodeAt(0))
}

/**
 * `cacheResponse:60`：缓存 GET / HEAD 的成功响应（按应用、域名与 URL，启用多语言时再按语言）；`cacheResponse:60,user` 按当前用户区分。
 * 只缓存 200，跳过 `Cache-Control: no-store / private` 的响应；缓存副本不含 Set-Cookie。
 * 响应头 `X-Cache: HIT / MISS`，命中时带 `Age`。存储为 config/cache.ts 的 responseStore（默认 default）。
 */
export const cacheResponse: MiddlewareHandler = async (ctx, next, ttlArg = '60', scope) => {
  if (ctx.method !== 'GET' && ctx.method !== 'HEAD')
    return next()
  const manager = ctx.make(CacheManager)
  const cache = manager.store(manager.config.responseStore)
  const ttl = parseDuration(ttlArg)
  // 多应用分发后 ctx.path 已去掉挂载前缀：键中带上应用名与域名，不同应用 / 域名下的同名路径互不串用；
  // 启用多语言时再按协商出的语言区分
  let key = `response:${ctx.appName ?? ''}|${ctx.url.host}${ctx.path}${ctx.url.search}`
  if (ctx.container.has(I18nManager) && ctx.make(I18nManager).enabled)
    key += `|locale:${ctx.locale}`
  if (scope === 'user')
    key += `|user:${(await ctx.auth.id().catch(() => undefined)) ?? 'guest'}`

  const hit = await cache.get<CachedResponse>(key)
  if (hit) {
    const headers = new Headers(hit.headers)
    headers.set('x-cache', 'HIT')
    headers.set('age', String(Math.max(0, Math.floor((Date.now() - hit.storedAt) / 1000))))
    return markBuffered(new Response(ctx.method === 'HEAD'
      ? null
      : fromBase64(hit.body) as Uint8Array<ArrayBuffer>, { status: hit.status, headers }))
  }

  ctx.onResponse(async (response) => {
    // 流式事件不会结束，读取整个 body 会一直挂起
    if (/^text\/event-stream/i.test(response.headers.get('content-type') ?? ''))
      return
    const cacheControl = response.headers.get('cache-control') ?? ''
    const headers = new Headers(response.headers)
    headers.set('x-cache', 'MISS')
    if (response.status !== 200 || /no-store|private/i.test(cacheControl) || !response.body)
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
    const body = new Uint8Array(await response.arrayBuffer())
    const stored = [...headers].filter(([name]) => name !== 'set-cookie' && name !== 'x-cache')
    await cache.set(key, {
      status: response.status,
      headers: stored,
      body: toBase64(body),
      storedAt: Date.now(),
    } satisfies CachedResponse, ttl)
    return new Response(body, { status: response.status, statusText: response.statusText, headers })
  })
  return next()
}
