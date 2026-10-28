export type PutContent = string | Uint8Array | ArrayBuffer | Blob | ReadableStream<Uint8Array>

export interface PutOptions {
  /** 默认按扩展名推断 */
  contentType?: string
  cacheControl?: string
  /** 下载时的文件名（Content-Disposition） */
  filename?: string
}

export interface FileMeta {
  path: string
  size: number
  contentType?: string
  lastModified?: Date
  etag?: string
}

/** 存储驱动：路径已规范化（相对磁盘根目录，不含 `..`） */
export interface DiskDriver {
  readonly driver: string
  put: (path: string, content: PutContent, options: PutOptions) => Promise<void>
  get: (path: string) => Promise<Uint8Array | undefined>
  stream: (path: string) => Promise<ReadableStream<Uint8Array> | undefined>
  meta: (path: string) => Promise<FileMeta | undefined>
  /** 返回文件是否存在过 */
  delete: (path: string) => Promise<boolean>
  copy: (from: string, to: string) => Promise<void>
  /** 前缀下的全部文件（递归） */
  list: (prefix: string) => Promise<string[]>
  /** 公开访问地址（配置了 url 时） */
  url?: (path: string) => string | undefined
  /** 原生预签名链接（S3）；没有时由框架的签名路由提供 */
  temporaryUrl?: (path: string, seconds: number, options: { download?: string }) => Promise<string>
}
