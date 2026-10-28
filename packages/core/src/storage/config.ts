import type { LocalDiskConfig } from './drivers/local'
import type { R2DiskConfig } from './drivers/r2'
import type { S3DiskConfig } from './drivers/s3'
import type { DiskDriver } from './types'

export interface MemoryDiskConfig {
  driver: 'memory'
  url?: string
}

export interface CustomDiskConfig {
  driver: 'custom'
  disk: DiskDriver
}

export type DiskConfig = LocalDiskConfig | S3DiskConfig | R2DiskConfig | MemoryDiskConfig | CustomDiskConfig

export interface FilesystemConfig {
  /** 默认磁盘，默认 local */
  default: string
  disks: Record<string, DiskConfig>
  /** 签名临时链接（没有原生预签名的磁盘：local / r2 / memory）的路由前缀，默认 `/__think/storage` */
  signedRoute?: string
}

export const defaultFilesystemConfig: FilesystemConfig = {
  default: 'local',
  disks: {
    local: { driver: 'local', root: 'storage/app' },
    public: {
      driver: 'local',
      root: 'storage/app/public',
      url: '/storage',
      serve: true,
    },
  },
}

/** `config/filesystem.ts` 的默认导出 */
export function defineFilesystemConfig(config: FilesystemConfig | (() => FilesystemConfig)): FilesystemConfig | (() => FilesystemConfig) {
  return config
}
