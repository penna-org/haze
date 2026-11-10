import type { MiddlewareHandler } from '../types'
import { mutableResponse } from '../../http/cookie'
import { parseSize } from '../../utils'

export type Encoding = 'br' | 'gzip' | 'deflate'

export interface CompressOptions {
  /** 小于该大小不压缩，默认 1kb */
  threshold?: string | number
  /** 按优先级排列的编码，默认 br、gzip、deflate（br 需要运行时提供 node:zlib） */
  encodings?: Encoding[]
  /**
   * 压缩级别。br 为 Brotli quality（0–11），默认 4：Node 的默认值 11 是为静态资源预压缩准备的，
   * 用在动态响应上会慢两个数量级；gzip / deflate 为 zlib level（0–9），设置后改用 node:zlib
   * （不设置时使用运行时内置的 CompressionStream 及其默认级别）
   */
  level?: Partial<Record<Encoding, number>>
}

/** 动态响应的 Brotli quality：压缩率接近 gzip -6 以上，耗时为 quality 11 的百分之一左右 */
const DEFAULT_BROTLI_QUALITY = 4

export function defineCompressConfig(config: CompressOptions | (() => CompressOptions)): CompressOptions | (() => CompressOptions) {
  return config
}

const COMPRESSIBLE = /^(?:text\/(?!event-stream)|application\/(?:json|javascript|xml|wasm|x-www-form-urlencoded|graphql|ld\+json|manifest\+json|[\w.+-]*\+(?:json|xml))|image\/svg\+xml|font\/(?:ttf|otf))/i

type Compressor = (level: number | undefined, size: number | undefined) => Promise<ReadableWritablePair<Uint8Array, Uint8Array> | undefined>

type WebPair = ReadableWritablePair<Uint8Array, Uint8Array>

/** gzip / deflate：指定了级别且运行时提供 node:zlib 时用它，否则用 CompressionStream */
function zlibCompressor(format: 'gzip' | 'deflate'): Compressor {
  return async (level) => {
    if (level !== undefined) {
      try {
        const [zlib, { Duplex }] = await Promise.all([import('node:zlib'), import('node:stream')])
        return Duplex.toWeb(format === 'gzip'
          ? zlib.createGzip({ level })
          : zlib.createDeflate({ level })) as unknown as WebPair
      }
      catch {}
    }
    return new CompressionStream(format) as unknown as WebPair
  }
}

const compressors: Record<Encoding, Compressor> = {
  br: async (level, size) => {
    try {
      const [{ createBrotliCompress, constants }, { Duplex }] = await Promise.all([import('node:zlib'), import('node:stream')])
      return Duplex.toWeb(createBrotliCompress({
        params: {
          [constants.BROTLI_PARAM_QUALITY]: level ?? DEFAULT_BROTLI_QUALITY,
          // 已知长度时告诉编码器，便于它选择窗口与缓冲大小
          ...(size !== undefined && { [constants.BROTLI_PARAM_SIZE_HINT]: size }),
        },
      })) as unknown as WebPair
    }
    catch {
      return undefined
    }
  },
  gzip: zlibCompressor('gzip'),
  deflate: zlibCompressor('deflate'),
}

/** 读取流的开头直到 limit 字节：返回拼回的完整流，以及整个流是否小于 limit */
async function peek(stream: ReadableStream<Uint8Array>, limit: number): Promise<{ stream: ReadableStream<Uint8Array>, small: boolean }> {
  const reader = stream.getReader()
  const head: Uint8Array[] = []
  let size = 0
  let done = false
  while (size < limit) {
    const chunk = await reader.read()
    if (chunk.done) {
      done = true
      break
    }
    head.push(chunk.value)
    size += chunk.value.byteLength
  }
  return {
    small: done,
    stream: new ReadableStream<Uint8Array>({
      start(controller) {
        head.forEach(chunk => controller.enqueue(chunk))
        if (done)
          controller.close()
      },
      async pull(controller) {
        const chunk = await reader.read()
        if (chunk.done)
          controller.close()
        else
          controller.enqueue(chunk.value)
      },
      cancel: reason => reader.cancel(reason),
    }),
  }
}

/** 按 Accept-Encoding（含 q 值）选择编码 */
export function negotiateEncoding(header: string | null, supported: Encoding[]): Encoding[] {
  if (!header)
    return []
  const accepted = new Map<string, number>()
  for (const part of header.split(',')) {
    const [name, ...params] = part.trim().toLowerCase().split(';')
    const q = params.map(param => param.trim()).find(param => param.startsWith('q='))
    accepted.set(name, q
      ? Number(q.slice(2))
      : 1)
  }
  return supported.filter(encoding => (accepted.get(encoding) ?? accepted.get('*') ?? 0) > 0)
}

/** `compress`：压缩响应体（文本、JSON、JS、SVG 等），在所有出站处理之后执行 */
export const compress: MiddlewareHandler = (ctx, next) => {
  const options = ctx.config.get<CompressOptions>('compress', {})
  const threshold = parseSize(options.threshold ?? '1kb')
  const candidates = negotiateEncoding(ctx.header('accept-encoding') ?? null, options.encodings ?? ['br', 'gzip', 'deflate'])
  if (!candidates.length || ctx.method === 'HEAD')
    return next()

  ctx.onResponse(async (response) => {
    const type = response.headers.get('content-type') ?? ''
    const length = response.headers.get('content-length')
    if (!response.body
      || [204, 206, 304].includes(response.status)
      || response.headers.has('content-encoding')
      || !COMPRESSIBLE.test(type)
      || /no-transform/i.test(response.headers.get('cache-control') ?? '')
      || (length !== null && Number(length) < threshold)) {
      return
    }
    // 长度未知（如 JSON、流）时先读到阈值：整个响应体都小于阈值则原样返回
    const body = length === null
      ? await peek(response.body, threshold)
      : { stream: response.body, small: false }
    const headers = new Headers(mutableResponse(response).headers)
    if (body.small)
      return new Response(body.stream, { status: response.status, statusText: response.statusText, headers })
    for (const encoding of candidates) {
      const compressor = await compressors[encoding](options.level?.[encoding], length === null || !Number.isFinite(Number(length))
        ? undefined
        : Number(length))
      if (!compressor)
        continue
      headers.delete('content-length')
      headers.set('content-encoding', encoding)
      const vary = headers.get('vary')
      if (!vary?.toLowerCase().includes('accept-encoding')) {
        headers.set('vary', vary
          ? `${vary}, Accept-Encoding`
          : 'Accept-Encoding')
      }
      return new Response(body.stream.pipeThrough(compressor), { status: response.status, statusText: response.statusText, headers })
    }
    return new Response(body.stream, { status: response.status, statusText: response.statusText, headers })
  })
  return next()
}
