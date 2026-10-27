import type { EnvironmentModuleNode, Plugin } from 'vite'
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path'
import process from 'node:process'
import { normalizePath } from 'vite'
import { PLUGIN_NAME, VIRTUAL_MODULES } from './constants'

export interface ThinkPluginOptions {
  /** 后端源码目录，相对 Vite root 或绝对路径，默认 `.` */
  srcDir?: string
  /** 指向 srcDir 的路径别名，默认 `~`；设为 false 关闭 */
  alias?: string | false
  /** 生产入口的默认端口 / 地址（运行时 PORT / HOST 环境变量优先） */
  port?: number
  host?: string
}

export interface ReloadEvent {
  type: 'create' | 'update' | 'delete'
  file: string
}

export interface ThinkPluginApi {
  /** 后端相关文件变化时通知（开发服务器据此热替换应用） */
  onReload: (listener: (event: ReloadEvent) => void) => () => void
}

const RESOLVED_PREFIX = '\0'
const SOURCE_RE = /\.[cm]?[jt]s$/
const virtualIds = new Set<string>(Object.values(VIRTUAL_MODULES))

export function thinkH3(options: ThinkPluginOptions = {}): Plugin<ThinkPluginApi> {
  const listeners = new Set<(event: ReloadEvent) => void>()
  let root = process.cwd()
  let srcDir = root
  let isDev = true

  const resolveSrcDir = (base: string): string => {
    const dir = options.srcDir ?? '.'
    return normalizePath(isAbsolute(dir)
      ? dir
      : resolve(base, dir))
  }

  return {
    name: PLUGIN_NAME,

    api: {
      onReload(listener) {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    },

    config(userConfig) {
      if (options.alias === false)
        return
      const base = resolve(userConfig.root ?? process.cwd())
      return {
        resolve: {
          alias: [
            {
              find: new RegExp(`^${escapeRegExp(options.alias ?? '~')}/`),
              replacement: `${resolveSrcDir(base)}/`,
            },
          ],
        },
      }
    },

    configResolved(config) {
      root = normalizePath(config.root)
      srcDir = resolveSrcDir(root)
      isDev = config.command === 'serve'
    },

    resolveId(id) {
      if (virtualIds.has(id))
        return RESOLVED_PREFIX + id
    },

    load(id) {
      if (!id.startsWith(RESOLVED_PREFIX))
        return
      switch (id.slice(RESOLVED_PREFIX.length)) {
        case VIRTUAL_MODULES.manifest:
          return manifestCode(root, srcDir, isDev)
        case VIRTUAL_MODULES.app:
          return appCode()
        case VIRTUAL_MODULES.serverEntry:
          return serverEntryCode(options)
      }
    },

    hotUpdate({ type, file, modules }) {
      if (this.environment.name !== 'ssr')
        return

      const isEnvFile = dirname(file) === root && basename(file).startsWith('.env')
      const isNewSource = type !== 'update' && file.startsWith(`${srcDir}/`) && SOURCE_RE.test(file)
      if (!modules.length && !isEnvFile && !isNewSource)
        return

      // 新增 / 删除文件时重新生成 glob 清单
      if (type !== 'update') {
        const manifest = this.environment.moduleGraph.getModuleById(RESOLVED_PREFIX + VIRTUAL_MODULES.manifest)
        if (manifest)
          this.environment.moduleGraph.invalidateModule(manifest)
      }

      listeners.forEach(listener => listener({ type, file }))
      // 由开发服务器整体重载应用，阻止 Vite 默认的 SSR 处理
      return [] as EnvironmentModuleNode[]
    },
  }
}

function manifestCode(root: string, srcDir: string, dev: boolean): string {
  const rel = normalizePath(relative(root, srcDir))
  const base = rel
    ? `/${rel}`
    : ''
  const glob = (pattern: string, extra = ''): string =>
    `import.meta.glob(${JSON.stringify(`${base}/${pattern}`)}, { eager: true${extra} })`

  return [
    `export const rootDir = ${dev
      ? JSON.stringify(root)
      : 'undefined'}`,
    `export const config = ${glob('config/*.{ts,mts,js,mjs}')}`,
    `export const routes = ${glob('route/*.{ts,mts,js,mjs}')}`,
    `export const providers = ${glob('app/provider/*.{ts,mts,js,mjs}')}`,
    `const handlers = ${glob('app/exception/Handler.{ts,mts,js,mjs}', ', import: \'default\'')}`,
    `export const exceptionHandler = Object.values(handlers)[0]`,
  ].join('\n')
}

function appCode(): string {
  return `
import { createApplication } from '@think-h3/core'
import * as manifest from '${VIRTUAL_MODULES.manifest}'

export { manifest }

export function createApp(options = {}) {
  return createApplication({
    rootDir: manifest.rootDir,
    config: manifest.config,
    routes: manifest.routes,
    providers: manifest.providers,
    exceptionHandler: manifest.exceptionHandler,
    ...options,
  })
}
`
}

function serverEntryCode(options: ThinkPluginOptions): string {
  return `
import process from 'node:process'
import { createApp } from '${VIRTUAL_MODULES.app}'

const app = await createApp({ mode: 'production' })
app.serve({
  port: Number(process.env.PORT) || ${options.port ?? 3000},
  hostname: process.env.HOST || ${JSON.stringify(options.host ?? '0.0.0.0')},
})
`
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
