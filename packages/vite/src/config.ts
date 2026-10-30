import type { UserConfig } from 'vite'
import type { DevtoolsConfig } from './devtools'
import type { ExternalsOptions } from './presets/deps'
import type { CloudflareOptions, PresetName, VercelOptions } from './presets/types'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { loadConfigFromFile } from 'vite'
import { CONFIG_BASENAME } from './constants'

export interface HazeConfig {
  /** 后端源码目录（相对项目根），默认 `.`；全栈项目一般为 `server` */
  srcDir?: string
  /** 开发服务器端口，默认 3000（环境变量 PORT 优先） */
  port?: number
  /** 监听地址，默认 localhost */
  host?: string
  /** 构建输出目录，默认 `dist` */
  outDir?: string
  /** 开发时自动生成配置键 / 路由名类型到 .haze/types，默认 true */
  typegen?: boolean
  /** 部署预设：node（默认）| bun | deno | docker | cloudflare | vercel | netlify | aws-lambda */
  preset?: PresetName
  /** cloudflare 预设：合并进 wrangler.json 的绑定等配置 */
  cloudflare?: CloudflareOptions
  /** vercel 预设：定时任务触发频率等 */
  vercel?: VercelOptions
  /** 依赖处理：默认能打包的都打包，驱动 / 原生模块追踪复制进产物的 node_modules */
  externals?: ExternalsOptions
  /** 开发时的 DevTools（需安装 `@hazejs/devtools`），默认开启；false 关闭 */
  devtools?: boolean | DevtoolsConfig
  /** 透传给 Vite 的配置（插件、别名等） */
  vite?: UserConfig
}

export interface ResolvedHazeConfig {
  root: string
  srcDir: string
  port: number
  host: string | undefined
  outDir: string
  typegen: boolean
  preset: PresetName | undefined
  cloudflare: CloudflareOptions | undefined
  vercel: VercelOptions | undefined
  externals: ExternalsOptions | undefined
  devtools: boolean | DevtoolsConfig
  vite: UserConfig
  configFile: string | undefined
}

export function defineHazeConfig(config: HazeConfig): HazeConfig {
  return config
}

const EXTENSIONS = ['ts', 'mts', 'js', 'mjs']
/** 以字符串引用 `@hazejs/vite`（import / require），注释中提到它不算 */
const HAZE_IMPORT_RE = /['"`]@hazejs\/vite['"`]/

/**
 * 使用 haze() 插件的 vite.config.* 视为全栈项目：由用户的 Vite 配置驱动。
 * 没有引入 `@hazejs/vite` 的 vite.config（如 monorepo 中只放 vite-plus 的 run / lint / test 配置）不算，仍按纯后端项目处理
 */
export function findViteConfig(root: string): string | undefined {
  return EXTENSIONS
    .map(ext => resolve(root, `vite.config.${ext}`))
    .find(file => existsSync(file) && HAZE_IMPORT_RE.test(readFileSync(file, 'utf8')))
}

/** 读取项目根目录下的 `haze.config.ts`（可选） */
export async function loadHazeConfig(root: string, mode = 'development'): Promise<ResolvedHazeConfig> {
  const configFile = EXTENSIONS
    .map(ext => resolve(root, `${CONFIG_BASENAME}.${ext}`))
    .find(file => existsSync(file))

  let config: HazeConfig = {}
  if (configFile) {
    const loaded = await loadConfigFromFile({ command: 'serve', mode }, configFile, root, 'silent')
    config = (loaded?.config ?? {}) as HazeConfig
  }

  return {
    root,
    srcDir: resolve(root, config.srcDir ?? '.'),
    port: config.port ?? 3000,
    host: config.host,
    outDir: resolve(root, config.outDir ?? 'dist'),
    typegen: config.typegen ?? true,
    preset: config.preset,
    cloudflare: config.cloudflare,
    vercel: config.vercel,
    externals: config.externals,
    devtools: config.devtools ?? true,
    vite: config.vite ?? {},
    configFile,
  }
}
