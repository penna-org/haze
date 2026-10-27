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
}

const kNotFound = Symbol.for('h3.notFound')
const IMMUTABLE = 'public, max-age=31536000, immutable'

/** 托管前端构建产物；位于异常边界之内、业务中间件之前 */
export function createStaticMiddleware(options: StaticOptions): H3Middleware {
  const dir = resolve(options.dir)
  const exclude = options.exclude ?? []
  const immutablePrefix = options.immutablePrefix ?? '/assets/'
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

    const served = await serveStatic(event, {
      fallthrough: true,
      getMeta: async (id) => {
        const file = toFile(id)
        const info = file
          ? await stat(file).catch(() => undefined)
          : undefined
        return info?.isFile()
          ? { size: info.size, mtime: info.mtimeMs }
          : undefined
      },
      getContents: id => readFile(toFile(id)!),
    })
    if (served) {
      if (path.startsWith(immutablePrefix))
        event.res.headers.set('cache-control', IMMUTABLE)
      return served
    }

    const result = await next()
    if (result !== kNotFound || !options.spaFallback || !acceptsHtml(event.req.headers))
      return result

    indexHtml ??= readFile(join(dir, 'index.html')).catch(() => undefined)
    const html = await indexHtml
    if (!html)
      return result
    return new Response(method === 'HEAD'
      ? null
      : new Uint8Array(html), {
      headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' },
    })
  }
}

function acceptsHtml(headers: Headers): boolean {
  return headers.get('accept')?.includes('text/html') ?? false
}
