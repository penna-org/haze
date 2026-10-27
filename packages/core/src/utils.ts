import { GLOBAL_KEY_PREFIX } from './constants'

export type Constructor<T = any> = new () => T
export type AbstractConstructor<T = any> = abstract new (...args: any[]) => T
export type MaybePromise<T> = T | Promise<T>

/** `import.meta.glob` 风格的模块记录：`{ '/route/api.ts': { default: ... } }` */
export type ModuleRecord = Record<string, unknown>

export function isClass(value: unknown): value is Constructor {
  return typeof value === 'function' && Function.prototype.toString.call(value).startsWith('class')
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object')
    return false
  const proto = Object.getPrototypeOf(value)
  return proto === null || proto === Object.prototype
}

export function toArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined)
    return []
  return Array.isArray(value)
    ? value
    : [value]
}

export function joinPath(...parts: string[]): string {
  const segments = parts
    .flatMap(part => part.split('/'))
    .filter(Boolean)
  return `/${segments.join('/')}`
}

/** 深合并：后者覆盖前者，数组整体替换 */
export function deepMerge<T extends Record<string, any>>(base: T, ...overrides: Record<string, any>[]): T {
  const result: Record<string, any> = { ...base }
  for (const override of overrides) {
    for (const [key, value] of Object.entries(override)) {
      result[key] = isPlainObject(value) && isPlainObject(result[key])
        ? deepMerge(result[key], value)
        : value
    }
  }
  return result as T
}

const MODULE_PATH_RE = /\.[cm]?[jt]sx?$/

export function isModuleRecord(value: unknown): value is ModuleRecord {
  return isPlainObject(value) && Object.keys(value).length > 0 && Object.keys(value).every(key => MODULE_PATH_RE.test(key))
}

/** 取模块的默认导出（兼容直接传值） */
export function unwrapDefault<T>(mod: unknown): T {
  if (mod && typeof mod === 'object' && 'default' in mod)
    return (mod as { default: T }).default
  return mod as T
}

/** 把 `import.meta.glob` 记录或数组统一成 `[name, value][]`，name 为不带扩展名的文件名 */
export function normalizeModules<T>(input: T[] | ModuleRecord | undefined): Array<[name: string | undefined, value: T]> {
  if (!input)
    return []
  if (Array.isArray(input))
    return input.map(value => [undefined, value])
  return Object.entries(input)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([path, mod]) => [
      basename(path),
      unwrapDefault<T>(mod),
    ])
}

function basename(path: string): string {
  return path.split('/').pop()!.replace(MODULE_PATH_RE, '')
}

/** 进程级（跨 HMR 重载）共享的全局存储 */
export function globalStore<T>(name: string, init: () => T): T {
  const key = `${GLOBAL_KEY_PREFIX}${name}`
  const g = globalThis as Record<string, unknown>
  return (g[key] ??= init()) as T
}

const SIZE_UNITS: Record<string, number> = {
  b: 1,
  kb: 1024,
  mb: 1024 ** 2,
  gb: 1024 ** 3,
}

/** `'1mb'` / `'512kb'` / `1024` → 字节数 */
export function parseSize(value: string | number): number {
  if (typeof value === 'number')
    return value
  const match = /^\s*(\d+(?:\.\d+)?)\s*(?:(b|kb|mb|gb)\s*)?$/i.exec(value)
  if (!match)
    throw new Error(`Invalid size "${value}" (expected e.g. 1mb, 512kb, 1024)`)
  return Math.floor(Number(match[1]) * SIZE_UNITS[(match[2] ?? 'b').toLowerCase()])
}

/** `'2h'` / `'30m'` / `'7d'` / `3600` → 秒数 */
export function parseDuration(value: string | number): number {
  if (typeof value === 'number')
    return value
  const match = /^\s*(\d+)\s*(?:([smhd])\s*)?$/i.exec(value)
  if (!match)
    throw new Error(`Invalid duration "${value}" (expected e.g. 30s, 15m, 2h, 7d)`)
  const unit = { s: 1, m: 60, h: 3600, d: 86400 }[(match[2] ?? 's').toLowerCase() as 's']
  return Number(match[1]) * unit
}
