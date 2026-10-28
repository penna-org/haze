import type { DataContent, GeneratedFile } from './types'

export function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let index = 0; index < bytes.length; index += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
  return btoa(binary)
}

export function fromBase64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), char => char.charCodeAt(0))
}

const SIGNATURES: Array<[bytes: number[], mediaType: string]> = [
  [
    [0x89, 0x50, 0x4E, 0x47],
    'image/png',
  ],
  [
    [0xFF, 0xD8, 0xFF],
    'image/jpeg',
  ],
  [
    [0x47, 0x49, 0x46, 0x38],
    'image/gif',
  ],
  [
    [0x25, 0x50, 0x44, 0x46],
    'application/pdf',
  ],
  [
    [0x49, 0x44, 0x33],
    'audio/mpeg',
  ],
  [
    [0xFF, 0xFB],
    'audio/mpeg',
  ],
  [
    [0x4F, 0x67, 0x67, 0x53],
    'audio/ogg',
  ],
  [
    [0x66, 0x4C, 0x61, 0x43],
    'audio/flac',
  ],
]

/** 按文件头推断媒体类型 */
export function detectMediaType(bytes: Uint8Array): string | undefined {
  // RIFF....WEBP / RIFF....WAVE
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) {
    const kind = String.fromCharCode(...bytes.subarray(8, 12))
    return kind === 'WEBP'
      ? 'image/webp'
      : kind === 'WAVE'
        ? 'audio/wav'
        : undefined
  }
  for (const [signature, mediaType] of SIGNATURES) {
    if (signature.every((byte, index) => bytes[index] === byte))
      return mediaType
  }
  return undefined
}

export interface ResolvedData {
  /** https: URL（未下载） */
  url?: string
  bytes?: Uint8Array
  base64?: string
  mediaType?: string
}

/** 统一二进制输入：data: URL 拆出类型与 base64，https: URL 保留，字节转 base64 */
export function resolveData(data: DataContent, mediaType?: string): ResolvedData {
  if (data instanceof URL)
    data = data.href
  if (typeof data === 'string') {
    const dataUrl = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(data)
    if (dataUrl) {
      const base64 = dataUrl[2]
        ? dataUrl[3]
        : toBase64(new TextEncoder().encode(decodeURIComponent(dataUrl[3])))
      return { base64, mediaType: mediaType ?? dataUrl[1] }
    }
    if (/^https?:\/\//i.test(data))
      return { url: data, mediaType }
    // 视为 base64
    const bytes = fromBase64(data)
    return { base64: data, bytes, mediaType: mediaType ?? detectMediaType(bytes) }
  }
  const bytes = data instanceof Uint8Array
    ? data
    : new Uint8Array(data)
  return {
    bytes,
    base64: toBase64(bytes),
    mediaType: mediaType ?? detectMediaType(bytes),
  }
}

/** 需要字节时（不支持 URL 的厂商）下载 https: URL */
export async function loadData(data: DataContent, mediaType?: string, signal?: AbortSignal): Promise<Required<Pick<ResolvedData, 'base64' | 'bytes'>> & { mediaType?: string }> {
  const resolved = resolveData(data, mediaType)
  if (resolved.url) {
    const response = await fetch(resolved.url, { signal })
    if (!response.ok)
      throw new Error(`Failed to download ${resolved.url}: ${response.status}`)
    const bytes = new Uint8Array(await response.arrayBuffer())
    return {
      bytes,
      base64: toBase64(bytes),
      mediaType: resolved.mediaType ?? response.headers.get('content-type')?.split(';')[0] ?? detectMediaType(bytes),
    }
  }
  const bytes = resolved.bytes ?? fromBase64(resolved.base64!)
  return { bytes, base64: resolved.base64 ?? toBase64(bytes), mediaType: resolved.mediaType }
}

export function generatedFile(data: Uint8Array | string, mediaType: string): GeneratedFile {
  const bytes = typeof data === 'string'
    ? fromBase64(data)
    : data
  let base64 = typeof data === 'string'
    ? data
    : undefined
  return {
    data: bytes,
    mediaType,
    get base64() {
      base64 ??= toBase64(bytes)
      return base64
    },
  }
}
