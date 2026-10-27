import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { parseEnv } from 'node:util'
import { globalStore } from '../utils'

export interface LoadEnvOptions {
  cwd?: string
  mode?: string
}

/** 由 .env 写入 process.env 的键；HMR 重载时允许被新值覆盖，真实环境变量始终优先 */
const loadedKeys = globalStore('envKeys', () => new Set<string>())

/**
 * 按 Vite 约定加载：`.env` → `.env.local` → `.env.[mode]` → `.env.[mode].local`，后者覆盖前者。
 * test 模式下跳过 `.env.local`，保证测试结果可复现。
 */
export function loadEnv(options: LoadEnvOptions = {}): Record<string, string> {
  const { cwd = process.cwd(), mode } = options
  const files = ['.env']
  if (mode !== 'test')
    files.push('.env.local')
  if (mode)
    files.push(`.env.${mode}`, `.env.${mode}.local`)

  const merged: Record<string, string> = {}
  for (const file of files) {
    const path = join(cwd, file)
    if (existsSync(path))
      Object.assign(merged, parseEnv(readFileSync(path, 'utf8')))
  }

  for (const [key, value] of Object.entries(merged)) {
    if (process.env[key] === undefined || loadedKeys.has(key)) {
      process.env[key] = value
      loadedKeys.add(key)
    }
  }
  return merged
}

type Widen<T> = T extends number ? number : T extends boolean ? boolean : string

const TRUTHY = new Set(['true', '1', 'yes', 'on'])
const FALSY = new Set(['false', '0', 'no', 'off', ''])

/**
 * 读取环境变量，按默认值的类型做转换：
 * `env('PORT', 3000)` → number，`env('APP_DEBUG', false)` → boolean。
 */
export function env(key: string): string | undefined
export function env<T extends string | number | boolean>(key: string, defaultValue: T): Widen<T>
export function env(key: string, defaultValue?: string | number | boolean): unknown {
  const raw = process.env[key]
  if (raw === undefined)
    return defaultValue

  switch (typeof defaultValue) {
    case 'number': {
      const value = Number(raw)
      return Number.isNaN(value)
        ? defaultValue
        : value
    }
    case 'boolean': {
      const normalized = raw.trim().toLowerCase()
      if (TRUTHY.has(normalized))
        return true
      if (FALSY.has(normalized))
        return false
      return defaultValue
    }
    default:
      return raw
  }
}
