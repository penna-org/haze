import type { Middleware as H3Middleware } from 'h3'
import type { Config } from '../config/config'
import type { DiskConfig, FilesystemConfig } from './config'
import type { DiskDriver } from './types'
import { ForbiddenException, NotFoundException } from '../exception/exceptions'
import { getRequestStore } from '../request'
import { appKey, sign, verify } from '../security/key'
import { tenantStoragePrefix } from '../tenancy/context'
import { defaultFilesystemConfig } from './config'
import { Disk, normalizePath } from './disk'
import { localDisk } from './drivers/local'
import { memoryDisk } from './drivers/memory'
import { r2Disk } from './drivers/r2'
import { s3Disk } from './drivers/s3'

function createDriver(name: string, config: DiskConfig): DiskDriver {
  switch (config.driver) {
    case 'local':
      return localDisk(config)
    case 's3':
      return s3Disk(config)
    case 'r2':
      return r2Disk(name, config)
    case 'memory':
      return withUrl(memoryDisk(), config.url)
    case 'custom':
      return config.disk
    default:
      throw new Error(`Storage disk "${name}": unknown driver "${(config as { driver: string }).driver}"`)
  }
}

function withUrl(driver: DiskDriver, url: string | undefined): DiskDriver {
  if (!url)
    return driver
  return {
    ...driver,
    url: path => `${url.replace(/\/$/, '')}/${path.split('/').map(encodeURIComponent).join('/')}`,
  }
}

/** 在驱动的所有路径前加上前缀（多租户的存储隔离） */
function prefixedDriver(driver: DiskDriver, prefix: string): DiskDriver {
  const add = (path: string): string => path
    ? `${prefix}/${path}`
    : prefix
  return {
    driver: driver.driver,
    put: (path, content, options) => driver.put(add(path), content, options),
    get: path => driver.get(add(path)),
    stream: path => driver.stream(add(path)),
    meta: async (path) => {
      const meta = await driver.meta(add(path))
      return meta && { ...meta, path }
    },
    delete: path => driver.delete(add(path)),
    copy: (from, to) => driver.copy(add(from), add(to)),
    list: async listPrefix => (await driver.list(`${prefix}/${listPrefix}`)).map(path => path.slice(prefix.length + 1)),
    url: driver.url && (path => driver.url!(add(path))),
    temporaryUrl: driver.temporaryUrl && ((path, seconds, options) => driver.temporaryUrl!(add(path), seconds, options)),
  }
}

const encodePath = (path: string): string => path.split('/').map(encodeURIComponent).join('/')
function payload(disk: string, path: string, expires: number, download: string | undefined): string {
  return `${disk}\n${path}\n${expires}\n${download ?? ''}`
}

/** Storage.fake()：内存磁盘 + 断言 */
export class FakeDisk extends Disk {
  async assertExists(path: string | string[]): Promise<void> {
    for (const item of Array.isArray(path)
      ? path
      : [path]) {
      if (await this.missing(item))
        throw new Error(`Expected file "${item}" to exist on disk "${this.name}"`)
    }
  }

  async assertMissing(path: string | string[]): Promise<void> {
    for (const item of Array.isArray(path)
      ? path
      : [path]) {
      if (await this.exists(item))
        throw new Error(`Expected file "${item}" not to exist on disk "${this.name}"`)
    }
  }

  async assertCount(dir: string, count: number): Promise<void> {
    const files = await this.files(dir, { recursive: true })
    if (files.length !== count)
      throw new Error(`Expected ${count} file(s) in "${dir}" on disk "${this.name}", got ${files.length}`)
  }

  async assertDirectoryEmpty(dir: string): Promise<void> {
    await this.assertCount(dir, 0)
  }
}

/** 文件存储管理（应用单例，`inject(StorageManager)`；config/filesystem.ts 缺省时为 local 与 public 两个本地磁盘） */
export class StorageManager {
  readonly #disks = new Map<string, Disk>()
  /** 租户磁盘：磁盘 → 租户前缀 → 加前缀的磁盘 */
  readonly #scoped = new WeakMap<Disk, Map<string, Disk>>()

  constructor(readonly appConfig: Config) {}

  get config(): FilesystemConfig {
    const config = this.appConfig.get<Partial<FilesystemConfig> | undefined>('filesystem', undefined)
    return {
      ...defaultFilesystemConfig,
      ...config,
      disks: {
        ...defaultFilesystemConfig.disks,
        ...config?.disks,
      },
    }
  }

  get signedRoute(): string {
    return (this.config.signedRoute ?? '/__haze/storage').replace(/\/$/, '')
  }

  /** 取磁盘（默认 default）；处于租户上下文时路径自动加上租户前缀（`tenants/<id>/`） */
  disk(name: string = this.config.default): Disk {
    const disk = this.#base(name)
    const prefix = tenantStoragePrefix(name)
    if (!prefix)
      return disk
    let scoped = this.#scoped.get(disk)
    if (!scoped)
      this.#scoped.set(disk, scoped = new Map())
    let tenantDisk = scoped.get(prefix)
    if (!tenantDisk) {
      // 保留磁盘的类（FakeDisk 的断言同样作用于租户目录）
      const DiskClass = disk.constructor as typeof Disk
      tenantDisk = new DiskClass(name, prefixedDriver(disk.driver, prefix), (diskName, path, expires, download) => this.#signUrl(diskName, `${prefix}/${path}`, expires, download))
      scoped.set(prefix, tenantDisk)
    }
    return tenantDisk
  }

  /** 配置中的磁盘（不加租户前缀） */
  #base(name: string): Disk {
    let disk = this.#disks.get(name)
    if (!disk) {
      const config = this.config.disks[name]
      if (!config)
        throw new Error(`Storage disk "${name}" is not defined in config/filesystem.ts`)
      disk = new Disk(name, createDriver(name, config), this.#signUrl)
      this.#disks.set(name, disk)
    }
    return disk
  }

  /** 测试：把磁盘替换为内存磁盘（保留配置中的 url），返回带断言的磁盘 */
  fake(name: string = this.config.default): FakeDisk {
    const url = (this.config.disks[name] as { url?: string } | undefined)?.url
    const disk = new FakeDisk(name, withUrl(memoryDisk(), url), this.#signUrl)
    this.#disks.set(name, disk)
    return disk
  }

  /** 撤销 fake，恢复为配置中的磁盘 */
  restore(name?: string): void {
    if (name)
      this.#disks.delete(name)
    else
      this.#disks.clear()
  }

  readonly #signUrl = async (disk: string, path: string, expires: number, download?: string): Promise<string> => {
    const signature = await sign(payload(disk, path, expires, download), appKey(this.appConfig))
    const query = new URLSearchParams({
      expires: String(expires),
      ...(download && { download }),
      signature,
    })
    const base = (this.appConfig.get<string | undefined>('app.url', undefined) ?? '').replace(/\/$/, '')
    return `${base}${this.signedRoute}/${encodeURIComponent(disk)}/${encodePath(path)}?${query}`
  }

  /** 校验签名链接，返回磁盘与路径 */
  async verifySignedUrl(url: URL): Promise<{ disk: Disk, path: string, download?: string } | undefined> {
    const rest = url.pathname.slice(this.signedRoute.length + 1)
    const slash = rest.indexOf('/')
    if (slash <= 0)
      return undefined
    const name = decodeURIComponent(rest.slice(0, slash))
    const path = normalizePath(decodeURIComponent(rest.slice(slash + 1)))
    const expires = Number(url.searchParams.get('expires'))
    const signature = url.searchParams.get('signature') ?? ''
    const download = url.searchParams.get('download') ?? undefined
    if (!Number.isFinite(expires) || expires < Date.now() / 1000)
      return undefined
    if (!(await verify(payload(name, path, expires, download), signature, appKey(this.appConfig))))
      return undefined
    if (!this.config.disks[name])
      return undefined
    // 签名中的路径已含租户前缀：使用不加前缀的磁盘
    return {
      disk: this.#base(name),
      path,
      download,
    }
  }

  /**
   * HTTP 中间件（框架自动安装，位于全局中间件之前）：
   * 签名临时链接路由，以及 `serve: true` 的本地磁盘按 url 提供文件。
   */
  middleware(): H3Middleware {
    const workers = typeof navigator !== 'undefined' && navigator.userAgent === 'Cloudflare-Workers'
    return async (event, next) => {
      const method = event.req.method
      if (method !== 'GET' && method !== 'HEAD')
        return next()
      const pathname = event.url.pathname
      if (pathname.startsWith(`${this.signedRoute}/`)) {
        const signed = await this.verifySignedUrl(event.url).catch(() => undefined)
        if (!signed)
          throw new ForbiddenException('Invalid or expired signature')
        return signed.disk.response(signed.path, { download: signed.download, request: event.req })
      }
      if (workers)
        return next()
      for (const [name, config] of Object.entries(this.config.disks)) {
        if (config.driver !== 'local' || !config.serve || !config.url?.startsWith('/'))
          continue
        const prefix = `${config.url.replace(/\/$/, '')}/`
        if (!pathname.startsWith(prefix))
          continue
        let path: string
        try {
          path = normalizePath(decodeURIComponent(pathname.slice(prefix.length)))
        }
        catch {
          return next()
        }
        if (!path)
          return next()
        try {
          return await this.#base(name).response(path, { request: event.req })
        }
        catch (error) {
          if (error instanceof NotFoundException)
            return next()
          throw error
        }
      }
      return next()
    }
  }
}

let fallback: StorageManager | undefined

/** @internal */
export function setStorageManager(manager: StorageManager | undefined): void {
  fallback = manager
}

export function useStorageManager(): StorageManager {
  const manager = getRequestStore()?.container.make(StorageManager) ?? fallback
  if (!manager)
    throw new Error('Storage is not available: the application has not booted')
  return manager
}

const methods = [
  'put',
  'putFile',
  'putFileAs',
  'get',
  'text',
  'json',
  'stream',
  'meta',
  'exists',
  'missing',
  'size',
  'delete',
  'deleteDirectory',
  'copy',
  'move',
  'files',
  'url',
  'temporaryUrl',
  'response',
  'download',
] as const

type Facade = Pick<Disk, typeof methods[number]> & {
  disk: (name?: string) => Disk
  fake: (name?: string) => FakeDisk
  restore: (name?: string) => void
}

/**
 * 存储门面：默认磁盘的快捷入口，`Storage.disk('s3')` 切换磁盘。
 *
 * ```ts
 * const path = await Storage.disk('public').putFile('avatars', file)
 * Storage.disk('public').url(path)
 * ```
 */
export const Storage: Facade = {
  disk: (name?: string) => useStorageManager().disk(name),
  fake: (name?: string) => useStorageManager().fake(name),
  restore: (name?: string) => useStorageManager().restore(name),
  ...Object.fromEntries(methods.map(method => [
    method,
    (...args: unknown[]) => (useStorageManager().disk() as any)[method](...args),
  ])),
} as Facade
