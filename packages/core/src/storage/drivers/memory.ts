import type { DiskDriver, FileMeta } from '../types'
import { toBytes, toStream } from '../content'
import { contentTypeOf } from '../mime'

/** 内存磁盘：Storage.fake() 与测试使用 */
export function memoryDisk(): DiskDriver & { files: Map<string, { bytes: Uint8Array, meta: FileMeta }> } {
  const files = new Map<string, { bytes: Uint8Array, meta: FileMeta }>()
  return {
    driver: 'memory',
    files,
    async put(path, content, options) {
      const bytes = await toBytes(content)
      files.set(path, {
        bytes,
        meta: {
          path,
          size: bytes.byteLength,
          contentType: options.contentType ?? contentTypeOf(path),
          lastModified: new Date(),
          etag: `"${bytes.byteLength}-${Date.now()}"`,
        },
      })
    },
    async get(path) {
      return files.get(path)?.bytes
    },
    async stream(path) {
      const file = files.get(path)
      return file && toStream(file.bytes)
    },
    async meta(path) {
      return files.get(path)?.meta
    },
    async delete(path) {
      return files.delete(path)
    },
    async copy(from, to) {
      const file = files.get(from)
      if (!file)
        throw new Error(`File not found: ${from}`)
      files.set(to, {
        bytes: file.bytes,
        meta: {
          ...file.meta,
          path: to,
          lastModified: new Date(),
        },
      })
    },
    async list(prefix) {
      return [
        ...files.keys(),
      ].filter(path => path.startsWith(prefix)).sort()
    },
  }
}
