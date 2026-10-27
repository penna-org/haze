import { resolve } from 'node:path'
import process from 'node:process'

export const rootArg = {
  root: {
    type: 'string',
    description: '项目根目录',
    default: '.',
  },
} as const

export const serverArgs = {
  port: {
    type: 'string',
    alias: 'p',
    description: '监听端口（默认读取 PORT 或 think.config.ts）',
  },
  host: {
    type: 'string',
    description: '监听地址',
  },
} as const

export function resolveRoot(root: string): string {
  return resolve(process.cwd(), root)
}

export function parsePort(port: string | undefined): number | undefined {
  if (port === undefined)
    return undefined
  const value = Number(port)
  if (!Number.isInteger(value) || value < 0)
    throw new Error(`Invalid port: ${port}`)
  return value
}

/** srvx 在监听所有地址时返回 `[::]` / `0.0.0.0`，展示为 localhost 便于点击 */
export function displayUrl(url: string): string {
  return url.replace(/\/\/(?:\[::\]|0\.0\.0\.0)/, '//localhost')
}
