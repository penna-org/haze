import type { DiskDriver, PutContent } from '../types'
import { toBytes } from '../content'
import { contentTypeOf } from '../mime'

export interface S3DiskConfig {
  driver: 's3'
  bucket: string
  region?: string
  /** S3 兼容服务（R2、RustFS、MinIO、OSS 等）的地址 */
  endpoint?: string
  /** 路径风格访问（多数自建 S3 兼容服务需要），默认有 endpoint 时为 true */
  forcePathStyle?: boolean
  accessKeyId?: string
  secretAccessKey?: string
  /** 键前缀 */
  root?: string
  /** 公开访问的 URL 前缀（CDN / 公共读的桶地址）；省略时 url() 返回 undefined，请用 temporaryUrl() */
  url?: string
  /** 超过该大小（字节）或内容为流时使用分片上传，默认 8MB */
  multipartThreshold?: number
}

type SDK = typeof import('@aws-sdk/client-s3')

async function load<T>(name: string, importer: () => Promise<T>): Promise<T> {
  try {
    return await importer()
  }
  catch (error) {
    throw new Error(`Storage driver "s3" requires ${name}. Install it with: pnpm add ${name}`, { cause: error })
  }
}

function isNotFound(error: unknown): boolean {
  const e = error as { name?: string, $metadata?: { httpStatusCode?: number } }
  return e?.name === 'NotFound' || e?.name === 'NoSuchKey' || e?.$metadata?.httpStatusCode === 404
}

/** AWS SDK v3 驱动：AWS S3 与 S3 兼容服务 */
export function s3Disk(config: S3DiskConfig): DiskDriver {
  const prefix = config.root
    ? `${config.root.replace(/^\/|\/$/g, '')}/`
    : ''
  const key = (path: string): string => prefix + path
  let client: Promise<{ sdk: SDK, s3: InstanceType<SDK['S3Client']> }> | undefined
  const connect = (): NonNullable<typeof client> => {
    client ??= load('@aws-sdk/client-s3', () => import('@aws-sdk/client-s3')).then(sdk => ({
      sdk,
      s3: new sdk.S3Client({
        region: config.region ?? 'us-east-1',
        endpoint: config.endpoint,
        forcePathStyle: config.forcePathStyle ?? Boolean(config.endpoint),
        ...(config.accessKeyId && config.secretAccessKey && {
          credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
        }),
      }),
    }))
    return client
  }

  const multipart = async (path: string, content: PutContent, contentType: string, extra: Record<string, unknown>): Promise<void> => {
    const { s3 } = await connect()
    const { Upload } = await load('@aws-sdk/lib-storage', () => import('@aws-sdk/lib-storage'))
    const body = content instanceof ReadableStream || content instanceof Blob
      ? content
      : await toBytes(content)
    await new Upload({
      client: s3,
      params: {
        Bucket: config.bucket,
        Key: key(path),
        Body: body as never,
        ContentType: contentType,
        ...extra,
      },
    }).done()
  }

  return {
    driver: 's3',
    async put(path, content, options) {
      const contentType = options.contentType ?? contentTypeOf(path)
      const extra = {
        ...(options.cacheControl && { CacheControl: options.cacheControl }),
        ...(options.filename && { ContentDisposition: `attachment; filename*=UTF-8''${encodeURIComponent(options.filename)}` }),
      }
      const threshold = config.multipartThreshold ?? 8 * 1024 * 1024
      if (content instanceof ReadableStream || (content instanceof Blob && content.size > threshold))
        return multipart(path, content, contentType, extra)
      const bytes = await toBytes(content)
      if (bytes.byteLength > threshold)
        return multipart(path, bytes, contentType, extra)
      const { sdk, s3 } = await connect()
      await s3.send(new sdk.PutObjectCommand({
        Bucket: config.bucket,
        Key: key(path),
        Body: bytes,
        ContentType: contentType,
        ...extra,
      }))
    },
    async get(path) {
      const { sdk, s3 } = await connect()
      try {
        const result = await s3.send(new sdk.GetObjectCommand({
          Bucket: config.bucket,
          Key: key(path),
        }))
        return await result.Body!.transformToByteArray()
      }
      catch (error) {
        if (isNotFound(error))
          return undefined
        throw error
      }
    },
    async stream(path) {
      const { sdk, s3 } = await connect()
      try {
        const result = await s3.send(new sdk.GetObjectCommand({
          Bucket: config.bucket,
          Key: key(path),
        }))
        return result.Body!.transformToWebStream() as ReadableStream<Uint8Array>
      }
      catch (error) {
        if (isNotFound(error))
          return undefined
        throw error
      }
    },
    async meta(path) {
      const { sdk, s3 } = await connect()
      try {
        const head = await s3.send(new sdk.HeadObjectCommand({
          Bucket: config.bucket,
          Key: key(path),
        }))
        return {
          path,
          size: head.ContentLength ?? 0,
          contentType: head.ContentType,
          lastModified: head.LastModified,
          etag: head.ETag,
        }
      }
      catch (error) {
        if (isNotFound(error))
          return undefined
        throw error
      }
    },
    async delete(path) {
      const existed = Boolean(await this.meta(path))
      const { sdk, s3 } = await connect()
      await s3.send(new sdk.DeleteObjectCommand({
        Bucket: config.bucket,
        Key: key(path),
      }))
      return existed
    },
    async copy(from, to) {
      const { sdk, s3 } = await connect()
      await s3.send(new sdk.CopyObjectCommand({
        Bucket: config.bucket,
        Key: key(to),
        CopySource: `${config.bucket}/${key(from).split('/').map(encodeURIComponent).join('/')}`,
      }))
    },
    async list(path) {
      const { sdk, s3 } = await connect()
      const keys: string[] = []
      let token: string | undefined
      do {
        const page = await s3.send(new sdk.ListObjectsV2Command({
          Bucket: config.bucket,
          Prefix: key(path),
          ContinuationToken: token,
        }))
        keys.push(...(page.Contents ?? []).map(item => item.Key!.slice(prefix.length)))
        token = page.IsTruncated ? page.NextContinuationToken : undefined
      } while (token)
      return keys.sort()
    },
    url: config.url
      ? path => `${config.url!.replace(/\/$/, '')}/${key(path).split('/').map(encodeURIComponent).join('/')}`
      : undefined,
    async temporaryUrl(path, seconds, options) {
      const { sdk, s3 } = await connect()
      const { getSignedUrl } = await load('@aws-sdk/s3-request-presigner', () => import('@aws-sdk/s3-request-presigner'))
      return getSignedUrl(s3, new sdk.GetObjectCommand({
        Bucket: config.bucket,
        Key: key(path),
        ...(options.download && { ResponseContentDisposition: `attachment; filename*=UTF-8''${encodeURIComponent(options.download)}` }),
      }), { expiresIn: seconds })
    },
  }
}
