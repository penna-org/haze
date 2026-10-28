import type { PutOptions } from '../storage/types'
import { useStorageManager } from '../storage/manager'

export interface StoreOptions extends PutOptions {
  /** 磁盘（config/filesystem.ts 的 disks），默认 default */
  disk?: string
}

/**
 * 上传的文件。继承 File：可直接交给 valibot 的 `v.file()` / `v.maxSize()` / `v.mimeType()` 校验，
 * `store()` 保存到存储磁盘（local / s3 / r2）。
 */
export class UploadedFile extends File {
  /** 表单字段名 */
  readonly field: string

  constructor(file: File, field: string) {
    super([file], file.name, { type: file.type, lastModified: file.lastModified })
    this.field = field
  }

  /** 客户端文件名的扩展名（小写，不含点），没有时为空字符串 */
  get extension(): string {
    const match = /\.([a-z0-9]+)$/i.exec(this.name)
    return match
      ? match[1].toLowerCase()
      : ''
  }

  /**
   * 保存到存储磁盘的目录下，文件名随机生成并保留扩展名，返回磁盘内路径：
   * `await file.store('avatars', 'public')`、`await file.store('docs', { disk: 's3' })`
   */
  async store(dir: string, options: string | StoreOptions = {}): Promise<string> {
    const { disk, ...put } = typeof options === 'string'
      ? { disk: options }
      : options
    return useStorageManager().disk(disk).putFile(dir, this, put)
  }

  /** 以指定文件名保存（只取文件名部分，防止路径穿越），返回磁盘内路径 */
  async storeAs(dir: string, name: string, options: string | StoreOptions = {}): Promise<string> {
    const { disk, ...put } = typeof options === 'string'
      ? { disk: options }
      : options
    return useStorageManager().disk(disk).putFileAs(dir, this, name, put)
  }

  toJSON(): { field: string, name: string, size: number, type: string } {
    return {
      field: this.field,
      name: this.name,
      size: this.size,
      type: this.type,
    }
  }
}

/** multipart 表单 → 对象：普通字段为字符串，文件为 UploadedFile，同名多值为数组 */
export function formDataToObject(form: FormData): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [key, raw] of form.entries()) {
    // 未选择文件的 <input type="file"> 会提交空文件
    if (typeof raw !== 'string' && !raw.name && raw.size === 0)
      continue
    const value = typeof raw === 'string'
      ? raw
      : new UploadedFile(raw, key)
    if (key in result) {
      const existing = result[key]
      result[key] = Array.isArray(existing)
        ? [...existing, value]
        : [existing, value]
    }
    else {
      result[key] = value
    }
  }
  return result
}
