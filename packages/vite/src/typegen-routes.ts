import type { RouteDefinition, RouteInfo } from '@hazejs/core'
import { existsSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import { normalizePath } from 'vite'

type JSONSchema = Record<string, any>
type Importer = (id: string) => Promise<any>
/** `router.records()` 的条目（带路由定义） */
type RouteRecord = RouteInfo & { definition?: RouteDefinition }

export interface RouteTypesOptions {
  root: string
  srcDir: string
  /** 生成文件所在目录（import() 路径相对于它） */
  typesDir: string
  /** 只有路由表时只能得到方法、路径与路径参数 */
  routes: readonly RouteRecord[]
  /**
   * 在应用的模块图中加载模块（与应用共享实例），用于把校验 schema、控制器对应回导出名，
   * 从而生成 `typeof import(...)` 形式的精确类型
   */
  import?: Importer
}

export interface RouteTypes {
  /** `interface GeneratedRoutes` 的成员 */
  lines: string[]
  /** 运行时路由清单（`.haze/routes.ts`）的内容 */
  manifest: string
  names: string[]
}

interface ExportRef {
  file: string
  name: string
}

const SOURCE_RE = /\.[cm]?[jt]s$/
/** 会被扫描并按对象身份匹配的目录（校验 schema 与控制器） */
const SCANNED_DIRS = new Set([
  'controller',
  'validate',
  'validator',
  'schema',
])
const IDENTIFIER_RE = /^[a-z_$][\w$]*$/i

/** 为命名路由生成客户端类型（GeneratedRoutes）与运行时路由清单 */
export async function generateRouteTypes(options: RouteTypesOptions): Promise<RouteTypes> {
  const exports = options.import
    ? await scanExports(options.srcDir, options.import)
    : new Map<unknown, ExportRef>()
  const importPath = (file: string): string => {
    let path = normalizePath(relative(options.typesDir, file)).replace(SOURCE_RE, '')
    if (!path.startsWith('.'))
      path = `./${path}`
    return JSON.stringify(path)
  }
  const reference = (value: unknown): string | undefined => {
    const ref = exports.get(value)
    if (!ref)
      return undefined
    return ref.name === 'default'
      ? `typeof import(${importPath(ref.file)}).default`
      : `typeof import(${importPath(ref.file)})${IDENTIFIER_RE.test(ref.name)
        ? `.${ref.name}`
        : `[${JSON.stringify(ref.name)}]`}`
  }
  const converter = createConverter(options.root, options.import)

  const named = options.routes
    .filter(route => route.name && route.method !== 'ALL' && !definitionOf(route)?.meta.websocket)
    .sort((a, b) => a.name!.localeCompare(b.name!))

  const lines: string[] = []
  const manifest: string[] = []
  for (const route of named) {
    const definition = definitionOf(route)
    const validate = definition?.validate ?? {}
    const pathParams = [
      ...route.path.matchAll(/:(\w+)/g),
    ].map(match => match[1])

    // 输入：已导出的 schema 用 SchemaInput<typeof import(...)>，内联 schema 由 JSON Schema 推出
    const input = async (schema: unknown): Promise<string> => {
      const ref = reference(schema)
      if (ref)
        return `SchemaInput<${ref}>`
      const json = await converter(schema)
      return json
        ? jsonSchemaToType(json)
        : 'unknown'
    }
    const fields = [
      `method: ${JSON.stringify(route.method)}`,
      `path: ${JSON.stringify(route.path)}`,
      `params: ${validate.params
        ? await input(validate.params)
        : pathParams.length
          ? `{ ${pathParams.map(param => `${propertyKey(param)}: string | number`).join(', ')} }`
          : 'never'}`,
    ]
    if (validate.query)
      fields.push(`query: ${await input(validate.query)}`)
    if (validate.body)
      fields.push(`body: ${await input(validate.body)}`)
    fields.push(`output: ${outputType(definition, reference)}`)

    lines.push(`    ${JSON.stringify(route.name)}: {\n${fields.map(field => `      ${field}`).join('\n')}\n    }`)
    manifest.push(`  ${JSON.stringify(route.name)}: { method: ${JSON.stringify(route.method)}, path: ${JSON.stringify(route.path)}${definition?.meta.envelope === false
      ? ', envelope: false'
      : ''} },`)
  }

  return {
    lines,
    names: named.map(route => route.name!),
    manifest: `// 由 hazejs 自动生成（haze dev / haze typegen），请勿手动修改
// 前端客户端的路由清单：createClient({ routes })
export const routes = {
${manifest.join('\n')}
} as const
`,
  }
}

function definitionOf(route: RouteRecord): RouteDefinition | undefined {
  return route.definition
}

/** 控制器方法的返回值类型；闭包处理器无法引用，为 unknown */
function outputType(definition: RouteDefinition | undefined, reference: (value: unknown) => string | undefined): string {
  const handler = definition?.handler
  if (!Array.isArray(handler))
    return 'unknown'
  const [controller, action] = handler as [unknown, string]
  const ref = reference(controller)
  return ref
    ? `Awaited<ReturnType<InstanceType<${ref}>[${JSON.stringify(action)}]>>`
    : 'unknown'
}

/** 递归收集 app 下 controller / validate 等目录中模块的导出（对象 → 文件与导出名） */
async function scanExports(srcDir: string, importer: Importer): Promise<Map<unknown, ExportRef>> {
  const result = new Map<unknown, ExportRef>()
  const files: string[] = []
  const walk = (dir: string, scanned: boolean): void => {
    if (!existsSync(dir))
      return
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory())
        walk(path, scanned || SCANNED_DIRS.has(entry.name))
      else if (scanned && SOURCE_RE.test(entry.name) && !entry.name.endsWith('.d.ts'))
        files.push(path)
    }
  }
  walk(join(srcDir, 'app'), false)
  // 本地模块的控制器与校验 schema
  if (existsSync(join(srcDir, 'modules'))) {
    for (const entry of readdirSync(join(srcDir, 'modules'), { withFileTypes: true }).filter(entry => entry.isDirectory()))
      walk(join(srcDir, 'modules', entry.name, 'app'), false)
  }

  for (const file of files.sort()) {
    const module = await importer(file).catch(() => undefined)
    if (!module || typeof module !== 'object')
      continue
    for (const [name, value] of Object.entries(module)) {
      if ((typeof value === 'object' || typeof value === 'function') && value !== null && !result.has(value))
        result.set(value, { file, name })
    }
  }
  return result
}

/** Standard JSON Schema 直接转换；valibot 使用项目中安装的 @valibot/to-json-schema（可选） */
function createConverter(root: string, importer: Importer | undefined): (schema: unknown) => Promise<JSONSchema | undefined> {
  let valibot: Promise<{ toJsonSchema: (schema: unknown, config: Record<string, unknown>) => JSONSchema } | undefined> | undefined
  const loadValibot = (): typeof valibot => {
    valibot ??= (async () => {
      try {
        return await importer!('@valibot/to-json-schema')
      }
      catch {}
      try {
        const require = createRequire(join(root, 'package.json'))
        return await import(pathToFileURL(require.resolve('@valibot/to-json-schema')).href)
      }
      catch {
        return undefined
      }
    })()
    return valibot
  }

  return async (schema) => {
    const standard = (schema as { '~standard'?: { vendor?: string, jsonSchema?: { input?: (options: { target: string }) => JSONSchema } } })?.['~standard']
    if (!standard)
      return undefined
    try {
      if (standard.jsonSchema?.input)
        return standard.jsonSchema.input({ target: 'draft-2020-12' })
      if (standard.vendor === 'valibot') {
        const converter = await loadValibot()
        return converter?.toJsonSchema(schema, {
          target: 'draft-2020-12',
          typeMode: 'input',
          errorMode: 'ignore',
          overrideSchema: ({ valibotSchema }: { valibotSchema: { type?: string } }) =>
            valibotSchema.type === 'file' || valibotSchema.type === 'blob'
              ? { type: 'string', format: 'binary' }
              : undefined,
        })
      }
    }
    catch {}
    return undefined
  }
}

function propertyKey(key: string): string {
  return IDENTIFIER_RE.test(key)
    ? key
    : JSON.stringify(key)
}

/** JSON Schema → TypeScript 类型（内联 schema 的退路，覆盖常见结构） */
export function jsonSchemaToType(schema: JSONSchema | boolean, root: JSONSchema | boolean = schema, seen: Set<string> = new Set()): string {
  if (schema === true || schema === undefined)
    return 'unknown'
  if (schema === false)
    return 'never'
  const convert = (child: JSONSchema | boolean): string => jsonSchemaToType(child, root, seen)

  if (typeof schema.$ref === 'string') {
    const match = /^#\/(?:\$defs|definitions)\/(.+)$/.exec(schema.$ref)
    const target = match && typeof root === 'object'
      ? (root.$defs ?? root.definitions)?.[match[1]]
      : undefined
    if (!target || seen.has(schema.$ref))
      return 'unknown'
    return jsonSchemaToType(target, root, new Set([...seen, schema.$ref]))
  }
  if ('const' in schema)
    return JSON.stringify(schema.const)
  if (Array.isArray(schema.enum))
    return union(schema.enum.map((value: unknown) => JSON.stringify(value)))
  if (Array.isArray(schema.anyOf) || Array.isArray(schema.oneOf))
    return union((schema.anyOf ?? schema.oneOf).map(convert))
  if (Array.isArray(schema.allOf))
    return schema.allOf.map((child: JSONSchema) => wrap(convert(child))).join(' & ') || 'unknown'
  if (Array.isArray(schema.type))
    return union(schema.type.map((type: string) => convert({ ...schema, type })))

  switch (schema.type) {
    case 'string':
      return schema.format === 'binary'
        ? 'Blob'
        : 'string'
    case 'number':
    case 'integer':
      return 'number'
    case 'boolean':
      return 'boolean'
    case 'null':
      return 'null'
    case 'array': {
      if (Array.isArray(schema.prefixItems))
        return `[${schema.prefixItems.map(convert).join(', ')}]`
      return `Array<${schema.items === undefined
        ? 'unknown'
        : convert(schema.items)}>`
    }
    case 'object':
      return objectType(schema, convert)
    default:
      return schema.properties
        ? objectType(schema, convert)
        : 'unknown'
  }
}

function objectType(schema: JSONSchema, convert: (child: JSONSchema | boolean) => string): string {
  const required = new Set<string>(schema.required ?? [])
  const members = Object.entries<JSONSchema>(schema.properties ?? {}).map(([key, value]) =>
    `${propertyKey(key)}${required.has(key)
      ? ''
      : '?'}: ${convert(value)}`)
  const extra = schema.additionalProperties
  if (extra !== undefined && extra !== false) {
    members.push(`[key: string]: ${extra === true
      ? 'unknown'
      : convert(extra)}`)
  }
  if (!members.length) {
    return extra === false
      ? 'Record<string, never>'
      : 'Record<string, unknown>'
  }
  return `{ ${members.join('; ')} }`
}

function union(types: string[]): string {
  const unique = [
    ...new Set(types),
  ]
  return unique.length
    ? unique.map(wrap).join(' | ')
    : 'never'
}

function wrap(type: string): string {
  return type.includes(' | ') || type.includes(' & ')
    ? `(${type})`
    : type
}
