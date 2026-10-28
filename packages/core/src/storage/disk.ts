import type { DiskDriver, FileMeta, PutContent, PutOptions } from './types'
import { NotFoundException } from '../exception/exceptions'
import { parseDuration } from '../utils'
import { contentTypeOf } from './mime'

const decoder = new TextDecoder()

/** 规范化路径：去掉开头的 `/`，拒绝 `..` 与空段，统一分隔符 */
export function normalizePath(path: string): string {
  const parts = path.replace(/\\/g, '/').split('/').filter(part => part && part !== '.')
  if (parts.includes('..'))
    throw new Error(`Invalid storage path "${path}"`)
  return parts.join('/')
}

function extensionOf(name: string): string {
  const match = /\.([a-z0-9]+)$/i.exec(name)
  return match
    ? `.${match[1].toLowerCase()}`
    : ''
}

function contentDisposition(type: 'inline' | 'attachment', filename: string): string {
  const fallback = filename.replace(/[^\x20-\x7E]|["\\]/g, '_')
  return `${type}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`
}

export interface ResponseOptions {
  /** 作为附件下载：true 取路径中的文件名，字符串为指定文件名 */
  download?: boolean | string
  headers?: ConstructorParameters<typeof Headers>[0]
  /** 请求（传入时支持 If-None-Match → 304） */
  request?: Request
}

export interface TemporaryUrlOptions {
  /** 下载时使用的文件名 */
  download?: string
}

/** 签名临时链接（框架路由）的生成器，由 StorageManager 注入 */
export type SignUrl = (disk: string, path: string, expiresAt: number, download?: string) => Promise<string>

/**
 * 磁盘：统一的文件读写接口（`Storage.disk('s3')`）。
 *
 * ```ts
 * await Storage.put('reports/2026.csv', csv)
 * const url = await Storage.disk('s3').temporaryUrl('reports/2026.csv', '10m')
 * ```
 */
export class Disk {
  constructor(
    readonly name: string,
    readonly driver: DiskDriver,
    private readonly signUrl: SignUrl,
  ) {}

  /** 写入文件，返回规范化后的路径 */
  async put(path: string, content: PutContent, options: PutOptions = {}): Promise<string> {
    const normalized = normalizePath(path)
    if (!normalized)
      throw new Error('Storage path must not be empty')
    await this.driver.put(normalized, content, options)
    return normalized
  }

  /** 保存 File（如上传文件）到目录，随机文件名并保留扩展名，返回路径 */
  async putFile(dir: string, file: File, options: PutOptions = {}): Promise<string> {
    return this.putFileAs(dir, file, `${crypto.randomUUID()}${extensionOf(file.name)}`, options)
  }

  /** 以指定文件名保存 File（只取文件名部分，防止路径穿越） */
  async putFileAs(dir: string, file: File, name: string, options: PutOptions = {}): Promise<string> {
    const safe = name.replace(/\\/g, '/').split('/').pop() ?? ''
    if (!safe || safe === '.' || safe === '..')
      throw new Error(`Invalid file name "${name}"`)
    return this.put(`${dir}/${safe}`, file.size > 1024 * 1024
      ? file.stream()
      : file, {
      contentType: file.type || contentTypeOf(safe),
      ...options,
    })
  }

  /** 读取文件，不存在时为 undefined */
  async get(path: string): Promise<Uint8Array | undefined> {
    return this.driver.get(normalizePath(path))
  }

  async text(path: string): Promise<string | undefined> {
    const bytes = await this.get(path)
    return bytes && decoder.decode(bytes)
  }

  async json<T = unknown>(path: string): Promise<T | undefined> {
    const text = await this.text(path)
    return text === undefined
      ? undefined
      : JSON.parse(text) as T
  }

  /** 流式读取，不存在时为 undefined */
  async stream(path: string): Promise<ReadableStream<Uint8Array> | undefined> {
    return this.driver.stream(normalizePath(path))
  }

  async meta(path: string): Promise<FileMeta | undefined> {
    return this.driver.meta(normalizePath(path))
  }

  async exists(path: string): Promise<boolean> {
    return Boolean(await this.meta(path))
  }

  async missing(path: string): Promise<boolean> {
    return !(await this.exists(path))
  }

  /** 文件大小（字节），不存在时为 undefined */
  async size(path: string): Promise<number | undefined> {
    return (await this.meta(path))?.size
  }

  /** 删除文件，返回实际删除的数量 */
  async delete(paths: string | string[]): Promise<number> {
    const list = Array.isArray(paths)
      ? paths
      : [paths]
    const results = await Promise.all(list.map(path => this.driver.delete(normalizePath(path))))
    return results.filter(Boolean).length
  }

  /** 删除前缀（目录）下的全部文件 */
  async deleteDirectory(prefix: string): Promise<number> {
    return this.delete(await this.files(prefix, { recursive: true }))
  }

  async copy(from: string, to: string): Promise<void> {
    if (!(await this.exists(from)))
      throw new Error(`File not found: ${from}`)
    await this.driver.copy(normalizePath(from), normalizePath(to))
  }

  async move(from: string, to: string): Promise<void> {
    await this.copy(from, to)
    await this.driver.delete(normalizePath(from))
  }

  /** 目录下的文件（默认只含直接子文件，`recursive: true` 含子目录） */
  async files(dir = '', options: { recursive?: boolean } = {}): Promise<string[]> {
    const normalized = normalizePath(dir)
    const prefix = normalized
      ? `${normalized}/`
      : ''
    const all = await this.driver.list(prefix)
    return options.recursive
      ? all
      : all.filter(path => !path.slice(prefix.length).includes('/'))
  }

  /** 公开访问地址（需要在磁盘配置中设置 url） */
  url(path: string): string {
    const url = this.driver.url?.(normalizePath(path))
    if (url === undefined)
      throw new Error(`Storage disk "${this.name}" has no public url: set "url" in config/filesystem.ts, or use temporaryUrl()`)
    return url
  }

  /**
   * 临时链接：S3 为原生预签名；local / r2 / memory 为框架签名路由（APP_KEY HMAC），
   * 地址前缀取 config/app.ts 的 url（APP_URL），未设置时为站内路径。
   */
  async temporaryUrl(path: string, expires: string | number, options: TemporaryUrlOptions = {}): Promise<string> {
    const normalized = normalizePath(path)
    const seconds = parseDuration(expires)
    if (this.driver.temporaryUrl)
      return this.driver.temporaryUrl(normalized, seconds, options)
    return this.signUrl(this.name, normalized, Math.floor(Date.now() / 1000) + seconds, options.download)
  }

  /** 文件响应（流式，带 Content-Type / Content-Length / ETag），不存在时抛出 404 */
  async response(path: string, options: ResponseOptions = {}): Promise<Response> {
    const normalized = normalizePath(path)
    const meta = await this.driver.meta(normalized)
    if (!meta)
      throw new NotFoundException('File not found')
    const headers = new Headers(options.headers)
    headers.set('content-type', meta.contentType ?? contentTypeOf(normalized))
    if (meta.etag)
      headers.set('etag', meta.etag)
    if (meta.lastModified)
      headers.set('last-modified', meta.lastModified.toUTCString())
    if (options.download) {
      const filename = typeof options.download === 'string'
        ? options.download
        : normalized.split('/').pop()!
      headers.set('content-disposition', contentDisposition('attachment', filename))
    }
    if (meta.etag && options.request?.headers.get('if-none-match') === meta.etag)
      return new Response(null, { status: 304, headers })
    if (options.request?.method === 'HEAD') {
      headers.set('content-length', String(meta.size))
      return new Response(null, { headers })
    }
    const body = await this.driver.stream(normalized)
    if (!body)
      throw new NotFoundException('File not found')
    headers.set('content-length', String(meta.size))
    return new Response(body, { headers })
  }

  /** 下载响应（Content-Disposition: attachment） */
  async download(path: string, name?: string): Promise<Response> {
    return this.response(path, { download: name ?? true })
  }
}
