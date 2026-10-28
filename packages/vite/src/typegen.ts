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

  const configs = configFiles.map((name) => {
    const key = name.replace(SOURCE_RE, '')
    let path = normalizePath(relative(typesDir, join(configDir, key)))
    if (!path.startsWith('.'))
      path = `./${path}`
    return { key, line: `    ${JSON.stringify(key)}: ConfigValue<typeof import(${JSON.stringify(path)}).default>` }
  })

  // app/policy/*.ts：能力名与模型策略的类型
  const policyDir = join(srcDir, 'app', 'policy')
  const policies = (existsSync(policyDir)
    ? readdirSync(policyDir).filter(name => SOURCE_RE.test(name) && !name.endsWith('.d.ts')).sort()
    : []).map((name) => {
    const key = name.replace(SOURCE_RE, '')
    let path = normalizePath(relative(typesDir, join(policyDir, key)))
    if (!path.startsWith('.'))
      path = `./${path}`
    return { key, line: `    ${JSON.stringify(key)}: typeof import(${JSON.stringify(path)}).default` }
  })

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
}
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
