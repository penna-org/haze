import type { ExternalsOptions, TraceResult } from './deps'

export const PRESET_NAMES = [
  'node',
  'bun',
  'deno',
  'docker',
  'cloudflare',
  'vercel',
  'netlify',
  'aws-lambda',
] as const

export type PresetName = (typeof PRESET_NAMES)[number]

/** think.config.ts 的 cloudflare 选项 */
export interface CloudflareOptions {
  /**
   * 合并进生成的 wrangler.json（D1 / KV / R2 绑定、vars、routes 等）。
   * `d1_databases` 中未设置 `migrations_dir` 的数据库使用产物中的 `migrations`（默认连接的迁移）。
   */
  wrangler?: Record<string, unknown>
  /** 生成 WebSocket 的 Durable Object（默认在路由中发现 r.ws() 时生成） */
  websocket?: boolean
}

/** think.config.ts 的 vercel 选项 */
export interface VercelOptions {
  /** 定时任务的触发频率（Vercel Cron 表达式），默认每分钟；Hobby 计划只允许每天一次 */
  cron?: string
}

export interface PresetContext {
  root: string
  /** think.config.ts 的 externals 选项 */
  externalsOptions: ExternalsOptions
  /** 后端源码目录（绝对路径） */
  srcDir: string
  /** think.config.ts 的 outDir（绝对路径） */
  outDir: string
  /** 是否包含前端（Vue 等）构建 */
  fullstack: boolean
  /** 交给后端处理的路径前缀（全栈模式） */
  prefixes: string[]
  port: number
  host: string | undefined
  /** 项目使用 @think-h3/orm：生成生产迁移入口 */
  orm: boolean
  cloudflare: CloudflareOptions | undefined
  vercel: VercelOptions | undefined
  /** 存在 schedule/*.ts：生成 Cron Triggers / Vercel Cron 等触发配置 */
  schedules: boolean
  /** 路由中使用了 r.ws()：Cloudflare 生成 WebSocket 的 Durable Object */
  websocket: boolean
}

export interface Layout {
  /** 服务端产物目录 */
  serverDir: string
  /** 前端产物目录（全栈模式） */
  clientDir: string | undefined
  /**
   * 运行时托管前端产物的目录（相对服务端入口）；
   * undefined 表示静态资源由平台（CDN）提供
   */
  staticFromServer: string | undefined
}

export interface FinalizeContext extends PresetContext {
  layout: Layout
  /** 服务端产物中仍需从 node_modules 加载的依赖 */
  externals: string[]
  /** 追踪复制进产物的依赖（未追踪时为 undefined） */
  traced: TraceResult | undefined
}

export interface Preset {
  name: PresetName
  /**
   * - external：依赖保留在 node_modules
   * - drivers-external：除数据库驱动（原生二进制 / WASM）外全部打包，驱动运行时安装或随产物复制
   * - all：全部打包（Edge 运行时没有 node_modules，驱动按 workerd 等条件使用其 Web 版本）
   */
  bundle: 'external' | 'drivers-external' | 'all'
  /**
   * 构建后把 external 依赖追踪复制进 `<serverDir>/node_modules`：
   * - default：默认开启，`externals.trace: false` 时关闭（node / bun 改为依赖全部 external）
   * - always：产物必须自带依赖（Serverless 函数）
   */
  trace?: 'default' | 'always'
  /** 产物的运行平台（与构建机不同时检查追踪到的原生包） */
  runtimePlatform?: NodeJS.Platform
  /** 构建时的 package.json exports 条件 */
  conditions?: string[]
  target?: string
  /** 打包平台：Edge 运行时使用 browser，避免生成依赖 import.meta.url 的 createRequire 辅助代码 */
  platform?: 'node' | 'browser' | 'neutral'
  /** 替换为“调用即报错”空模块的包（该运行时不支持） */
  unsupported?: string[]
  /** 输出单文件（Workers 要求入口模块只导出处理器，不能被拆分出的 chunk 反向导入） */
  singleFile?: boolean
  /** 保留为运行时导入的模块（如 Workers 的 `cloudflare:*`） */
  external?: RegExp[]
  /** 输出独立的迁移脚本 `migrate.mjs`（常驻进程型运行时，部署前执行） */
  migrateScript?: boolean
  layout: (context: PresetContext) => Layout
  /** 生产入口（virtual:think/server-entry）源码 */
  entry: (context: PresetContext & { layout: Layout }) => string
  /** 构建完成后生成平台配置、复制依赖等 */
  finalize?: (context: FinalizeContext) => Promise<void>
  /** 构建完成后提示如何运行 / 部署 */
  hint: (context: FinalizeContext) => string
}
