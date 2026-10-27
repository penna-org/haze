import type { UserConfig } from 'vite'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { loadConfigFromFile } from 'vite'
import { CONFIG_BASENAME } from './constants'

export interface ThinkConfig {
  /** 后端源码目录（相对项目根），默认 `.`；全栈项目一般为 `server` */
  srcDir?: string
  /** 开发服务器端口，默认 3000（环境变量 PORT 优先） */
  port?: number
  /** 监听地址，默认 localhost */
  host?: string
  /** 构建输出目录，默认 `dist` */
  outDir?: string
  /** 透传给 Vite 的配置（插件、别名等） */
  vite?: UserConfig
}

export interface ResolvedThinkConfig {
  root: string
  srcDir: string
  port: number
  host: string | undefined
  outDir: string
  vite: UserConfig
  configFile: string | undefined
}

export function defineThinkConfig(config: ThinkConfig): ThinkConfig {
  return config
}

const EXTENSIONS = ['ts', 'mts', 'js', 'mjs']

/** 存在 vite.config.* 视为全栈项目：由用户的 Vite 配置（含 thinkH3() 插件）驱动 */
export function findViteConfig(root: string): string | undefined {
  return EXTENSIONS
    .map(ext => resolve(root, `vite.config.${ext}`))
    .find(file => existsSync(file))
}

/** 读取项目根目录下的 `think.config.ts`（可选） */
export async function loadThinkConfig(root: string, mode = 'development'): Promise<ResolvedThinkConfig> {
  const configFile = EXTENSIONS
    .map(ext => resolve(root, `${CONFIG_BASENAME}.${ext}`))
    .find(file => existsSync(file))

  let config: ThinkConfig = {}
  if (configFile) {
    const loaded = await loadConfigFromFile({ command: 'serve', mode }, configFile, root, 'silent')
    config = (loaded?.config ?? {}) as ThinkConfig
  }

  return {
    root,
    srcDir: resolve(root, config.srcDir ?? '.'),
    port: config.port ?? 3000,
    host: config.host,
    outDir: resolve(root, config.outDir ?? 'dist'),
    vite: config.vite ?? {},
    configFile,
  }
}
