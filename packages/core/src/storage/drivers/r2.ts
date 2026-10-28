import type { DiskDriver, FileMeta } from '../types'
import { usePlatformBinding } from '../../platform'
import { toBytes } from '../content'
import { contentTypeOf } from '../mime'

export interface R2DiskConfig {
  driver: 'r2'
  /** Workers 绑定名（wrangler.json 的 r2_buckets），默认 BUCKET，或直接传入 R2Bucket */
  binding?: string | object
  /** 公开访问的 URL 前缀（R2 公共域名 / 自定义域名） */
  url?: string
}

interface R2Object {
  key: string
  size: number
  etag: string
  httpEtag: string
  uploaded: Date
  httpMetadata?: { contentType?: string }
}

interface R2Bucket {
  put: (key: string, value: ReadableStream | ArrayBuffer | Uint8Array | string | Blob, options?: { httpMetadata?: Record<string, string> }) => Promise<R2Object>
  get: (key: string) => Promise<(R2Object & { body: ReadableStream<Uint8Array>, arrayBuffer: () => Promise<ArrayBuffer> }) | null>
  head: (key: string) => Promise<R2Object | null>
  delete: (key: string) => Promise<void>
  list: (options: { prefix?: string, cursor?: string }) => Promise<{ objects: R2Object[], truncated: boolean, cursor?: string }>
}

/**
 * Cloudflare R2（Workers 绑定）。预签名链接由框架的签名路由提供；
 * 需要 R2 原生预签名时改用 s3 驱动连接 R2 的 S3 接口。
 */
export function r2Disk(name: string, config: R2DiskConfig): DiskDriver {
  const bucket = (): R2Bucket => {
    const binding = typeof config.binding === 'object'
      ? config.binding
      : usePlatformBinding<object>(config.binding ?? 'BUCKET')
    if (!binding)
      throw new Error(`Storage disk "${name}": R2 binding "${config.binding ?? 'BUCKET'}" not found. R2 bindings are only available on Cloudflare Workers`)
    return binding as R2Bucket
  }
  const meta = (object: R2Object): FileMeta => ({
    path: object.key,
    size: object.size,
    contentType: object.httpMetadata?.contentType,
    lastModified: object.uploaded,
    etag: object.httpEtag,
  })
  return {
    driver: 'r2',
    async put(path, content, options) {
      const body = content instanceof ReadableStream
        ? await toBytes(content)
        : content
      await bucket().put(path, body as never, {
        httpMetadata: {
          contentType: options.contentType ?? contentTypeOf(path),
          ...(options.cacheControl && { cacheControl: options.cacheControl }),
        },
      })
    },
    async get(path) {
      const object = await bucket().get(path)
      return object
        ? new Uint8Array(await object.arrayBuffer())
        : undefined
    },
    async stream(path) {
      return (await bucket().get(path))?.body
    },
    async meta(path) {
      const object = await bucket().head(path)
      return object
        ? {
            ...meta(object),
            path,
          }
        : undefined
    },
    async delete(path) {
      const existed = Boolean(await bucket().head(path))
      await bucket().delete(path)
      return existed
    },
    async copy(from, to) {
      const object = await bucket().get(from)
      if (!object)
        throw new Error(`File not found: ${from}`)
      await bucket().put(to, await object.arrayBuffer(), { httpMetadata: object.httpMetadata as Record<string, string> })
    },
    async list(prefix) {
      const keys: string[] = []
      let cursor: string | undefined
      do {
        const page = await bucket().list({ prefix, cursor })
        keys.push(...page.objects.map(object => object.key))
        cursor = page.truncated ? page.cursor : undefined
      } while (cursor)
      return keys.sort()
    },
    url: config.url
      ? path => `${config.url!.replace(/\/$/, '')}/${path.split('/').map(encodeURIComponent).join('/')}`
      : undefined,
  }
}
