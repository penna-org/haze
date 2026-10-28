import type { DiskDriver } from '../types'
import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import process from 'node:process'
import { toBytes } from '../content'
import { contentTypeOf } from '../mime'

export interface LocalDiskConfig {
  driver: 'local'
  /** 根目录（相对运行目录或绝对路径），默认 storage/app */
  root?: string
  /** 公开访问的 URL 前缀（如 `/storage` 或 CDN 地址） */
  url?: string
  /** 由框架在 url 路径下直接提供文件（url 须为站内路径），默认 false */
  serve?: boolean
}

/** 本地文件系统（Node / Bun / Deno） */
function workingDir(): string {
  return process.cwd()
}

export function localDisk(config: LocalDiskConfig): DiskDriver {
  // 运行时求值：避免构建时的依赖追踪（nf3 / nft）把 cwd 下的全部文件视为被引用
  const root = resolve(workingDir(), config.root ?? 'storage/app')
  const full = (path: string): string => {
    const target = isAbsolute(path)
      ? path
      : join(root, path)
    // 防止路径穿越到根目录之外
    if (target !== root && !target.startsWith(root + sep))
      throw new Error(`Path escapes the disk root: ${path}`)
    return target
  }
  const exists = async (path: string): Promise<boolean> => stat(full(path)).then(info => info.isFile(), () => false)

  async function walk(dir: string): Promise<string[]> {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    const files = await Promise.all(entries.map(entry => entry.isDirectory()
      ? walk(join(dir, entry.name))
      : Promise.resolve([
          join(dir, entry.name),
        ])))
    return files.flat()
  }

  return {
    driver: 'local',
    async put(path, content) {
      const target = full(path)
      await mkdir(dirname(target), { recursive: true })
      if (content instanceof ReadableStream) {
        // 流式写入，不在内存中整体缓冲
        const [{ createWriteStream }, { Readable }, { pipeline }] = await Promise.all([import('node:fs'), import('node:stream'), import('node:stream/promises')])
        await pipeline(Readable.fromWeb(content as never), createWriteStream(target))
      }
      else {
        await writeFile(target, await toBytes(content))
      }
    },
    async get(path) {
      return readFile(full(path)).then(buffer => new Uint8Array(buffer), () => undefined)
    },
    async stream(path) {
      if (!(await exists(path)))
        return undefined
      const [{ createReadStream }, { Readable }] = await Promise.all([import('node:fs'), import('node:stream')])
      return Readable.toWeb(createReadStream(full(path))) as unknown as ReadableStream<Uint8Array>
    },
    async meta(path) {
      const info = await stat(full(path)).catch(() => undefined)
      if (!info?.isFile())
        return undefined
      return {
        path,
        size: info.size,
        contentType: contentTypeOf(path),
        lastModified: info.mtime,
        etag: `W/"${info.size.toString(16)}-${info.mtimeMs.toString(16)}"`,
      }
    },
    async delete(path) {
      const existed = await exists(path)
      await rm(full(path), { force: true })
      return existed
    },
    async copy(from, to) {
      await mkdir(dirname(full(to)), { recursive: true })
      await copyFile(full(from), full(to))
    },
    async list(prefix) {
      const base = full(prefix.endsWith('/')
        ? prefix
        : dirname(`${prefix}x`))
      return (await walk(base))
        .map(file => relative(root, file).split(sep).join('/'))
        .filter(path => path.startsWith(prefix))
        .sort()
    },
    url: config.url
      ? path => `${config.url!.replace(/\/$/, '')}/${path.split('/').map(encodeURIComponent).join('/')}`
      : undefined,
  }
}
