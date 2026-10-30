import type { Middleware as H3Middleware } from 'h3'
import { readFile, stat } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { serveStatic } from 'h3'

export interface StaticOptions {
  /** 静态资源目录（绝对路径） */
  dir: string
  /** 未命中文件的 HTML 页面请求回退到 index.html，用于前端路由（history 模式） */
  spaFallback?: boolean
  /** 不处理的路径前缀，例如 `['/api']` */
  exclude?: string[]
  /** 带 hash 的构建产物目录，设置长期缓存，默认 `/assets/` */
  immutablePrefix?: string
  /**
   * 构建时预先压缩好的文件（`app.js.br`、`app.js.gz`）：按 Accept-Encoding 直接返回，请求时不再压缩。
   * true 为 `{ br: '.br', gzip: '.gz' }`，也可传编码 → 扩展名；没有对应的压缩文件时返回原文件
   */
  precompressed?: boolean | Record<string, string>
}

const PRECOMPRESSED: Record<string, string> = { br: '.br', gzip: '.gz' }

const kNotFound = Symbol.for('h3.notFound')
const IMMUTABLE = 'public, max-age=31536000, immutable'

/** 托管前端构建产物；位于全局中间件之后（安全头、CORS 同样作用于静态文件）、路由之前 */
export function createStaticMiddleware(options: StaticOptions): H3Middleware {
  const dir = resolve(options.dir)
  const exclude = options.exclude ?? []
  const immutablePrefix = options.immutablePrefix ?? '/assets/'
  const encodings = options.precompressed === true
    ? PRECOMPRESSED
    : options.precompressed || undefined
  let indexHtml: Promise<Uint8Array | undefined> | undefined

  // id 保持编码状态（h3 已做规范化与穿越检查），这里再确认最终路径位于 dir 内
  const toFile = (id: string): string | undefined => {
    const file = join(dir, id)
    return file === dir || file.startsWith(dir + sep)
      ? file
      : undefined
  }

  const isExcluded = (path: string): boolean =>
    exclude.some(prefix => path === prefix || path.startsWith(`${prefix}/`))

  return async (event, next) => {
    const path = event.url.pathname
    const method = event.req.method
    if (isExcluded(path) || (method !== 'GET' && method !== 'HEAD'))
      return next()

    // 预压缩副本：按配置的顺序（默认 br 优先）选择客户端接受的第一个存在的副本
    const accepted = encodings && acceptedEncodings(event.req.headers.get('accept-encoding'))
    const compressed = new Map<string, string>()
    const served = await serveStatic(event, {
      fallthrough: true,
      getMeta: async (id) => {
        const file = toFile(id)
        const info = file
          ? await stat(file).catch(() => undefined)
          : undefined
        if (!file || !info?.isFile())
          return undefined
        for (const [encoding, ext] of Object.entries(encodings ?? {})) {
          if (!accepted?.(encoding))
            continue
          const copy = await stat(file + ext).catch(() => undefined)
          if (copy?.isFile()) {
            compressed.set(id, file + ext)
            return { size: copy.size, mtime: info.mtimeMs, encoding }
          }
        }
        return { size: info.size, mtime: info.mtimeMs }
      },
      getContents: id => readFile(compressed.get(id) ?? toFile(id)!),
    })
    if (served) {
      if (encodings)
        appendVary(event.res.headers, 'accept-encoding')
      if (path.startsWith(immutablePrefix))
        event.res.headers.set('cache-control', IMMUTABLE)
      // 页面（index.html 等）每次向服务器确认，发布新版本后刷新即生效
      else if (event.res.headers.get('content-type')?.startsWith('text/html') && !event.res.headers.has('cache-control'))
        event.res.headers.set('cache-control', 'no-cache')
      return served
    }

    const result = await next()
    if (result !== kNotFound || !options.spaFallback || !acceptsHtml(event.req.headers))
      return result

    indexHtml ??= readFile(join(dir, 'index.html')).catch(() => undefined)
    const html = await indexHtml
    if (!html)
      return result
    event.res.headers.set('content-type', 'text/html; charset=utf-8')
    event.res.headers.set('cache-control', 'no-cache')
    return new Response(method === 'HEAD'
      ? null
      : new Uint8Array(html), {
      headers: event.res.headers,
    })
  }
}

/** Accept-Encoding 是否接受某个编码（q=0 表示拒绝，`*` 匹配其余编码） */
function acceptedEncodings(header: string | null): (encoding: string) => boolean {
  const weights = new Map<string, number>()
  for (const part of (header ?? '').split(',')) {
    const [name = '', ...params] = part.trim().toLowerCase().split(';')
    if (!name)
      continue
    const q = params.map(param => param.trim()).find(param => param.startsWith('q='))
    weights.set(name.trim(), q
      ? Number(q.slice(2)) || 0
      : 1)
  }
  return (encoding) => {
    const q = weights.get(encoding) ?? weights.get('*')
    return q !== undefined && q > 0
  }
}

function appendVary(headers: Headers, value: string): void {
  const vary = headers.get('vary')
  if (!vary)
    headers.set('vary', value)
  else if (!vary.toLowerCase().split(',').some(item => item.trim() === value || item.trim() === '*'))
    headers.set('vary', `${vary}, ${value}`)
}

function acceptsHtml(headers: Headers): boolean {
  return headers.get('accept')?.includes('text/html') ?? false
}
