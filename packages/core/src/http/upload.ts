import { mkdir, writeFile } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'

/**
 * 上传的文件。继承 File：可直接交给 valibot 的 `v.file()` / `v.maxSize()` / `v.mimeType()` 校验，
 * 或 `fetch` / 对象存储 SDK 上传。
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
    return extname(this.name).slice(1).toLowerCase()
  }

  /**
   * 保存到本地目录（相对运行目录或绝对路径），文件名随机生成并保留扩展名，返回保存路径。
   * 本地文件系统之外的存储（S3 / R2 等）请读取 `arrayBuffer()` / `stream()` 自行上传。
   */
  async store(dir: string): Promise<string> {
    const name = `${crypto.randomUUID()}${this.extension
      ? `.${this.extension}`
      : ''}`
    return this.storeAs(dir, name)
  }

  /** 以指定文件名保存（只取文件名部分，防止路径穿越） */
  async storeAs(dir: string, name: string): Promise<string> {
    const safe = basename(name)
    if (!safe || safe === '.' || safe === '..')
      throw new Error(`Invalid file name "${name}"`)
    await mkdir(dir, { recursive: true })
    const path = join(dir, safe)
    await writeFile(path, new Uint8Array(await this.arrayBuffer()))
    return path
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
