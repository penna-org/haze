import type { MiddlewareHandler } from '../types'
import { CacheManager } from '../../cache/manager'
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
 * `cacheResponse:60`：缓存 GET / HEAD 的成功响应（按 URL）；`cacheResponse:60,user` 按当前用户区分。
 * 只缓存 200，跳过 `Cache-Control: no-store / private` 的响应；缓存副本不含 Set-Cookie。
 * 响应头 `X-Cache: HIT / MISS`，命中时带 `Age`。存储为 config/cache.ts 的 responseStore（默认 default）。
 */
export const cacheResponse: MiddlewareHandler = async (ctx, next, ttlArg = '60', scope) => {
  if (ctx.method !== 'GET' && ctx.method !== 'HEAD')
    return next()
  const manager = ctx.make(CacheManager)
  const cache = manager.store(manager.config.responseStore)
  const ttl = parseDuration(ttlArg)
  let key = `response:${ctx.path}${ctx.url.search}`
  if (scope === 'user')
    key += `|user:${(await ctx.auth.id().catch(() => undefined)) ?? 'guest'}`

  const hit = await cache.get<CachedResponse>(key)
  if (hit) {
    const headers = new Headers(hit.headers)
    headers.set('x-cache', 'HIT')
    headers.set('age', String(Math.max(0, Math.floor((Date.now() - hit.storedAt) / 1000))))
    return new Response(ctx.method === 'HEAD'
      ? null
      : fromBase64(hit.body) as Uint8Array<ArrayBuffer>, { status: hit.status, headers })
  }

  ctx.onResponse(async (response) => {
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
