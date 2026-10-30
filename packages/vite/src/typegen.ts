import type { RouteInfo } from '@hazejs/core'
import type { RouteTypes } from './typegen-routes'
import { existsSync, readdirSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { normalizePath } from 'vite'
import { PLUGIN_NAME } from './constants'
import { writeI18nTypes } from './typegen-i18n'
import { generateRouteTypes } from './typegen-routes'

export interface TypegenOptions {
  root: string
  srcDir: string
  /** `app.router.list()`；传 `app.router.records()` 时还会生成客户端的输入输出类型 */
  routes: readonly RouteInfo[]
  /** 在应用的模块图中加载模块（`devServer.import`），用于引用校验 schema 与控制器的类型 */
  import?: (id: string) => Promise<any>
  /** 客户端路由类型（writeTypes 内部生成） */
  client?: RouteTypes
}

export interface TypegenResult {
  file: string
  changed: boolean
  configs: string[]
  routes: string[]
  policies: string[]
}

const SOURCE_RE = /\.[cm]?[jt]s$/

/** 生成文件位置（需在 tsconfig 的 include 中加入 `.haze/types/**\/*.d.ts`） */
export function typesFile(root: string): string {
  return join(root, '.haze', 'types', 'haze.d.ts')
}

/** 前端客户端的运行时路由清单 */
export function routesFile(root: string): string {
  return join(root, '.haze', 'routes.ts')
}

/** 生成配置键与命名路由的类型声明（模块扩充 @hazejs/core） */
export function generateTypes({ root, srcDir, routes, client }: TypegenOptions): Omit<TypegenResult, 'changed'> & { content: string } {
  const file = typesFile(root)
  const typesDir = join(file, '..')
  const configDir = join(srcDir, 'config')
  const configFiles = existsSync(configDir)
    ? readdirSync(configDir).filter(name => SOURCE_RE.test(name) && !name.endsWith('.d.ts')).sort()
    : []

  const importPath = (file: string): string => {
    const path = normalizePath(relative(typesDir, file))
    return JSON.stringify(path.startsWith('.')
      ? path
      : `./${path}`)
  }
  const configs = configFiles.map((name) => {
    const key = name.replace(SOURCE_RE, '')
    // 带上文件扩展名：moduleResolution 为 nodenext 的 ESM 项目中不带扩展名的相对导入解析不到（类型退化为 any）
    const type = `ConfigValue<typeof import(${importPath(join(configDir, name))}).default>`
    return { key, type, line: `    ${JSON.stringify(key)}: ${type}` }
  })
  // 本地模块的默认配置（modules/<name>/config/*.ts，middleware.ts 为中间件声明除外）：项目没有同名配置文件时加入
  for (const dir of localModuleDirs(srcDir)) {
    for (const name of sourceFiles(join(dir, 'config'))) {
      const key = name.replace(SOURCE_RE, '')
      if (key === 'middleware' || configs.some(item => item.key === key))
        continue
      const type = `ConfigValue<typeof import(${importPath(join(dir, 'config', name))}).default>`
      configs.push({ key, type, line: `    ${JSON.stringify(key)}: ${type}` })
    }
  }

  // app/policy/*.ts（含本地模块的 modules/<name>/app/policy）：能力名与模型策略的类型
  const policies: Array<{ key: string, line: string }> = []
  for (const policyDir of [
    join(srcDir, 'app', 'policy'),
    ...localModuleDirs(srcDir).map(dir => join(dir, 'app', 'policy')),
  ]) {
    for (const name of sourceFiles(policyDir)) {
      const key = name.replace(SOURCE_RE, '')
      if (!policies.some(item => item.key === key))
        policies.push({ key, line: `    ${JSON.stringify(key)}: typeof import(${importPath(join(policyDir, name))}).default` })
    }
  }

  const named = routes
    .filter(route => route.name)
    .map((route) => {
      const params = [
        ...route.path.matchAll(/:(\w+)/g),
      ].map(match => match[1])
      const type = params.length
        ? `{ ${params.map(param => `${param}: string | number`).join(', ')} }`
        : 'Record<never, never>'
      return { name: route.name!, line: `    ${JSON.stringify(route.name)}: ${type}` }
    })
    .sort((a, b) => a.name.localeCompare(b.name))

  // Redis 连接名单独生成（不经过 GeneratedConfig）：config/cache.ts 等写 `connection: 'default'` 时不会形成循环引用
  const redis = configs.find(item => item.key === 'redis')

  const content = `// 由 ${PLUGIN_NAME} 自动生成（haze dev / haze typegen），请勿手动修改
import type { ConfigValue } from '@hazejs/core'
${client
  ? `import type { SchemaInput } from '@hazejs/core/client'\n`
  : ''}
declare module '@hazejs/core' {
  interface GeneratedConfig {
${configs.map(item => item.line).join('\n')}
  }

  interface RouteNames {
${named.map(item => item.line).join('\n')}
  }

  interface GeneratedPolicies {
${policies.map(item => item.line).join('\n')}
  }
${redis
  ? `
  interface GeneratedRedisConnections {
    connections: ${redis.type}['connections']
  }
`
  : ''}}
${client
  ? `
declare module '@hazejs/core/client' {
  interface GeneratedRoutes {
${client.lines.join('\n')}
  }
}
`
  : ''}
export {}
`
  return {
    file,
    content,
    configs: configs.map(item => item.key),
    routes: named.map(item => item.name),
    policies: policies.map(item => item.key),
  }
}

/** 本地模块目录 modules/<name>/ */
export function localModuleDirs(srcDir: string): string[] {
  const dir = join(srcDir, 'modules')
  return existsSync(dir)
    ? readdirSync(dir, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => join(dir, entry.name)).sort()
    : []
}

function sourceFiles(dir: string): string[] {
  return existsSync(dir)
    ? readdirSync(dir).filter(name => SOURCE_RE.test(name) && !name.endsWith('.d.ts')).sort()
    : []
}

/** 内容变化时才写入，避免触发编辑器与文件监听的无谓刷新 */
export async function writeTypes(options: TypegenOptions): Promise<TypegenResult> {
  const client = options.client ?? await generateRouteTypes({
    root: options.root,
    srcDir: options.srcDir,
    typesDir: join(typesFile(options.root), '..'),
    routes: options.routes,
    import: options.import,
  })
  const { content, ...result } = generateTypes({ ...options, client })
  const changed = [
    await writeIfChanged(result.file, content),
    await writeIfChanged(routesFile(options.root), client.manifest),
    // lang/<locale>/*.ts 的翻译键（.haze/types/i18n.d.ts）
    (await writeI18nTypes({ root: options.root, srcDir: options.srcDir })).changed,
  ].some(Boolean)
  return { ...result, changed }
}

async function writeIfChanged(file: string, content: string): Promise<boolean> {
  const previous = await readFile(file, 'utf8').catch(() => undefined)
  if (previous === content)
    return false
  await mkdir(join(file, '..'), { recursive: true })
  await writeFile(file, content)
  return true
}
