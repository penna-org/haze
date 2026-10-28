import type { ConfigInput } from './config/config'
import type { DiscoveredCommand } from './console/command'
import type { Interceptor } from './http/interceptor'
import type { MiddlewareClass, MiddlewareConfig, MiddlewareHandler, MiddlewareRef } from './middleware/types'
import type { ProviderInput } from './provider'
import type { RouteModule, RouteRegistrar } from './routing/builder'
import type { ModuleRecord } from './utils'
import { fileURLToPath } from 'node:url'
import { resolveConfigInput } from './config/config'
import { collectCommands, isCommand } from './console/command'
import { builtinMiddleware } from './middleware/builtin'
import { isRouteModule } from './routing/builder'
import { deepMerge, isModuleRecord, isPlainObject, normalizeModules, unwrapDefault } from './utils'

const kModule = Symbol.for('hazejs.module')

/**
 * 模块提供的一组定义：数组、`{ 名称: 值 }`（键为任务名 / 事件名 / 命令名等），
 * 或 `import.meta.glob` 记录（文件名为名称，与项目自身的约定一致）
 */
export type ModuleItems<T = unknown> = T[] | Record<string, T> | ModuleRecord

/** 模块带来的中间件：别名、分组与全局中间件（与 config/middleware.ts 同形） */
export interface ModuleMiddleware {
  alias?: Record<string, MiddlewareHandler | MiddlewareClass>
  groups?: Record<string, MiddlewareRef[]>
  /** 追加在项目全局中间件之后，按模块启用顺序执行 */
  global?: MiddlewareRef[]
}

/** 启用模块时的挂载选项：`blog({ prefix: '/api/blog' })` 或 config/modules.ts 的 `local.blog` */
export interface ModuleOptions {
  /** 模块路由的 URL 前缀 */
  prefix?: string
  /** 路由名前缀，默认 `<模块名>.`；传 `''` 不加前缀 */
  as?: string
  /** 追加到模块全部路由上的中间件（在模块自身声明的路由中间件之后） */
  middleware?: MiddlewareRef[]
  /** 只挂载到某个子应用（config/app.ts 的 apps），默认挂载到主应用 */
  app?: string
  /** 模块迁移使用的数据库连接，默认 default 连接 */
  connection?: string
}

/** `defineModule()` 的定义 */
export interface ModuleDefinition<O = object> {
  /** 模块名（本地模块默认取 modules/<name> 的目录名） */
  name?: string
  /** 默认的 URL 前缀（启用时的 prefix 优先） */
  prefix?: string
  /** 默认的路由名前缀，默认 `<模块名>.` */
  as?: string
  /** 模块全部路由默认带上的中间件 */
  routeMiddleware?: MiddlewareRef[]
  /** 默认挂载到的子应用 */
  app?: string
  /** 迁移使用的连接 */
  connection?: string
  /** 默认配置：`{ blog: { perPage: 20 } }`，位于项目配置之下，项目的 config/blog.ts 可覆盖 */
  config?: Record<string, ConfigInput<Record<string, any>>>
  /** 路由模块（defineRoutes） */
  routes?: RouteModule | RouteRegistrar | ModuleItems<RouteModule | RouteRegistrar>
  middleware?: ModuleMiddleware
  /** 服务提供者：先于项目的提供者 register，项目可以覆盖模块的绑定 */
  providers?: ModuleItems<ProviderInput>
  interceptors?: ModuleItems<Interceptor>
  policies?: ModuleItems
  jobs?: ModuleItems
  schedules?: ModuleItems
  events?: ModuleItems
  listeners?: ModuleItems
  notifications?: ModuleItems
  /** 广播频道授权（defineChannels） */
  channels?: ModuleItems
  /** 自定义命令（defineCommand）；import.meta.glob 记录可按需加载 */
  commands?: ModuleItems
  /** 其它按目录发现的定义，供扩展包读取（如 sockets、messages） */
  discovered?: Record<string, ModuleItems>
  /**
   * 迁移目录（drizzle-kit 的输出）：`new URL('../database/migrations', import.meta.url)`、绝对路径，
   * 或相对后端源码目录的路径；false 表示没有迁移。本地模块默认为 modules/<name>/database/migrations
   */
  migrations?: string | URL | false
  /** 带类型的启用选项：返回值与定义合并（如按选项生成默认配置） */
  options?: (options: O) => Omit<ModuleDefinition, 'name' | 'options'> | void
}

/** 已传入选项的模块（`blog({ ... })` 的返回值） */
export interface EnabledModule {
  readonly [kModule]: ModuleDefinition<any>
  readonly options: ModuleOptions & Record<string, unknown>
}

/** `defineModule()` 的返回值：可直接启用，也可以带选项调用 */
export interface HazeModule<O = object> {
  (options?: ModuleOptions & O): EnabledModule
  readonly [kModule]: ModuleDefinition<O>
  readonly moduleName: string | undefined
}

export type ModuleInput = HazeModule<any> | EnabledModule

/** `config/modules.ts` */
export interface ModulesConfig {
  /** 启用的模块包（按顺序加载，迁移也按此顺序执行） */
  modules?: ModuleInput[]
  /** 本地模块（modules/<name>/）默认全部启用：false 关闭，对象为挂载选项 */
  local?: Record<string, boolean | ModuleOptions>
}

/**
 * 定义模块（npm 包的入口或 modules/<name>/module.ts）：
 *
 * ```ts
 * export default defineModule({
 *   name: 'blog',
 *   config: { blog: { perPage: 20 } },
 *   routes: [blogRoutes],
 *   middleware: { alias: { 'blog.owner': EnsureOwner } },
 *   providers: [BlogProvider],
 *   migrations: new URL('../database/migrations', import.meta.url),
 * })
 * ```
 */
export function defineModule<O extends object = object>(definition: ModuleDefinition<O>): HazeModule<O> {
  const enable = (options: ModuleOptions & O = {} as ModuleOptions & O): EnabledModule => ({
    [kModule]: definition,
    options: options as ModuleOptions & Record<string, unknown>,
  })
  return Object.assign(enable, {
    [kModule]: definition,
    moduleName: definition.name,
  }) as HazeModule<O>
}

/** `config/modules.ts` 的默认导出 */
export function defineModulesConfig(config: ConfigInput<ModulesConfig>): ConfigInput<ModulesConfig> {
  return config
}

export function isHazeModule(value: unknown): value is ModuleInput {
  return (typeof value === 'function' || (typeof value === 'object' && value !== null)) && kModule in value
}

/** 启用后的模块：合并了选项与定义 */
export interface ResolvedModule {
  name: string
  /** `package`：npm 包或手动传入；`local`：modules/<name>/ */
  source: 'package' | 'local'
  /** URL 前缀（`''` 表示不加前缀） */
  prefix: string
  /** 路由名前缀 */
  as: string
  /** 模块路由的额外中间件 */
  middleware: MiddlewareRef[]
  app?: string
  connection?: string
  /** 迁移目录：绝对路径，或相对后端源码目录的路径（生产构建中为内嵌文件的键） */
  migrations?: string
  definition: ModuleDefinition<any>
}

export interface ResolveModulesOptions {
  /** 手动传入的模块（createApplication({ modules })） */
  explicit?: readonly unknown[]
  /** config/modules.ts */
  config?: ModulesConfig
  /** modules/<name>/ 下发现的文件（import.meta.glob 记录） */
  local?: ModuleRecord
}

/**
 * 按启用顺序解析模块：手动传入的模块 → config/modules.ts 的 modules → 本地模块（按目录名）。
 * 重名、未知的本地模块名会直接报错
 */
export function resolveModules(options: ResolveModulesOptions): ResolvedModule[] {
  const result: ResolvedModule[] = []
  const add = (module: ResolvedModule, from: string): void => {
    const other = result.find(item => item.name === module.name)
    if (other) {
      throw new Error(`Module "${module.name}" is enabled twice (${other.source === 'local'
        ? `modules/${other.name}`
        : 'a package'} and ${from})`)
    }
    result.push(module)
  }

  const packages = [
    ...(options.explicit ?? []),
    ...(options.config?.modules ?? []),
  ]
  for (const input of packages) {
    if (!isHazeModule(input))
      throw new TypeError('config/modules.ts: every entry of `modules` must be a module created with defineModule()')
    const definition = input[kModule]
    if (!definition.name)
      throw new Error('defineModule() needs a name for modules published as packages')
    const options = typeof input === 'function'
      ? {}
      : input.options
    add(resolveOne(definition.name, 'package', definition, options), `package "${definition.name}"`)
  }

  const local = groupLocalModules(options.local)
  const settings = options.config?.local ?? {}
  for (const name of Object.keys(settings)) {
    if (!local.has(name))
      throw new Error(`config/modules.ts: local module "${name}" does not exist (expected modules/${name}/)`)
  }
  for (const [name, definition] of [...local].sort(([a], [b]) => a.localeCompare(b))) {
    const setting = settings[name] ?? true
    if (setting === false)
      continue
    add(resolveOne(name, 'local', definition, setting === true
      ? {}
      : setting as ModuleOptions & Record<string, unknown>), `modules/${name}`)
  }
  return result
}

const NAME_RE = /^[a-z0-9][\w-]*$/i

function resolveOne(name: string, source: ResolvedModule['source'], base: ModuleDefinition<any>, options: ModuleOptions & Record<string, unknown>): ResolvedModule {
  if (!NAME_RE.test(name))
    throw new Error(`Invalid module name "${name}" (letters, digits, - and _)`)
  const extra = base.options?.(options) ?? undefined
  const definition = extra
    ? mergeDefinitions(base, extra)
    : base
  const migrations = definition.migrations === undefined && source === 'local'
    ? `modules/${name}/database/migrations`
    : normalizeFolder(definition.migrations)
  return {
    name,
    source,
    prefix: normalizePrefix(options.prefix ?? definition.prefix),
    as: options.as ?? definition.as ?? `${name}.`,
    middleware: [
      ...(definition.routeMiddleware ?? []),
      ...(options.middleware ?? []),
    ],
    app: options.app ?? definition.app,
    connection: options.connection ?? definition.connection,
    migrations,
    definition,
  }
}

function normalizePrefix(prefix: string | undefined): string {
  const trimmed = (prefix ?? '').replace(/^\/+|\/+$/g, '')
  return trimmed
    ? `/${trimmed}`
    : ''
}

function normalizeFolder(folder: string | URL | false | undefined): string | undefined {
  if (folder === undefined || folder === false)
    return undefined
  const path = folder instanceof URL
    ? folder.protocol === 'file:'
      ? fileURLToPath(folder)
      : folder.href
    : folder
  return path.replace(/(?<=.)[/\\]+$/, '')
}

const LIST_FIELDS = [
  'routes',
  'providers',
  'interceptors',
  'policies',
  'jobs',
  'schedules',
  'events',
  'listeners',
  'notifications',
  'channels',
  'commands',
] as const

/** 合并两份定义：列表拼接（base 在前），配置深合并，其余字段后者优先 */
export function mergeDefinitions(base: ModuleDefinition<any>, override: Omit<ModuleDefinition<any>, 'options'>): ModuleDefinition<any> {
  const merged: ModuleDefinition<any> = {
    ...base,
    ...override,
    options: base.options,
  }
  for (const field of LIST_FIELDS) {
    if (base[field] !== undefined && override[field] !== undefined)
      (merged as Record<string, unknown>)[field] = group(base[field], override[field])
  }
  if (base.config && override.config) {
    // 同名配置深合并（函数形式在求值时合并）
    merged.config = { ...base.config }
    for (const [key, value] of Object.entries(override.config)) {
      const previous = merged.config[key]
      merged.config[key] = previous === undefined
        ? value
        : () => deepMerge(resolveConfigInput(previous), resolveConfigInput(value))
    }
  }
  if (base.middleware && override.middleware) {
    merged.middleware = {
      alias: {
        ...base.middleware.alias,
        ...override.middleware.alias,
      },
      groups: {
        ...base.middleware.groups,
        ...override.middleware.groups,
      },
      global: [
        ...(base.middleware.global ?? []),
        ...(override.middleware.global ?? []),
      ],
    }
  }
  if (base.discovered && override.discovered) {
    merged.discovered = { ...base.discovered }
    for (const [key, items] of Object.entries(override.discovered))
      merged.discovered[key] = group(merged.discovered[key], items)
  }
  return merged
}

/** 合并后的列表按来源分组保存（各组保持原样，glob 记录的文件路径不会丢失） */
const kEntries = Symbol.for('hazejs.module.entries')
type Entries = Array<[string | undefined, unknown]> & { [kEntries]?: true }

function isGroup(value: unknown): value is Entries {
  return Array.isArray(value) && Boolean((value as Entries)[kEntries])
}

function group(...parts: unknown[]): Entries {
  const result: Entries = []
  for (const part of parts) {
    if (part === undefined)
      continue
    if (isGroup(part))
      result.push(...part)
    else
      result.push([undefined, part])
  }
  result[kEntries] = true
  return result
}

/** 把模块的定义列表统一成 `[名称, 值][]`（名称为文件名或对象键，数组项为 undefined） */
export function moduleEntries<T = unknown>(items: unknown): Array<[name: string | undefined, value: T]> {
  if (items === undefined || items === null)
    return []
  if (Array.isArray(items)) {
    // 合并过的列表（见 mergeDefinitions）：逐组展开
    if (isGroup(items))
      return items.flatMap(([, value]) => moduleEntries<T>(value))
    return items.map(value => [undefined, value as T])
  }
  if (isRouteModule(items) || typeof items === 'function' || isCommand(items)) {
    return [
      [undefined, items as T],
    ]
  }
  if (isModuleRecord(items))
    return normalizeModules<T>(items)
  if (isPlainObject(items)) {
    return Object.entries(items).map(([name, value]) => [
      name,
      unwrapDefault<T>(value),
    ])
  }
  return [
    [undefined, items as T],
  ]
}

/** 模块的自定义命令：glob 记录按路径命名，`{ 名称: 命令 }` 按键命名，数组需要 defineCommand({ name }) */
export async function moduleCommands(module: ResolvedModule): Promise<DiscoveredCommand[]> {
  const items = module.definition.commands
  if (!items)
    return []
  const groups: unknown[] = isGroup(items)
    ? items.map(([, value]) => value)
    : [items]
  const found: DiscoveredCommand[] = []
  for (const group of groups) {
    if (Array.isArray(group)) {
      found.push(...await collectCommands(group as never))
    }
    else if (isModuleRecord(group)) {
      found.push(...await collectCommands(group))
    }
    else if (isCommand(group)) {
      found.push(...await collectCommands([group]))
    }
    else if (isPlainObject(group)) {
      for (const [name, command] of Object.entries(group)) {
        const value = unwrapDefault<unknown>(command)
        if (isCommand(value))
          found.push({ name: value.name ?? name, command: value })
      }
    }
  }
  return found.map(item => ({ ...item, module: module.name }))
}

/** 模块按名称发现的定义（`app.discovered(name)`）：notifications / channels 与 discovered 中的同名项 */
export function moduleDiscovered(module: ResolvedModule, name: string): Array<[string | undefined, unknown]> {
  const { definition } = module
  return [
    ...(name === 'notifications'
      ? moduleEntries(definition.notifications)
      : []),
    ...(name === 'channels'
      ? moduleEntries(definition.channels)
      : []),
    ...moduleEntries(definition.discovered?.[name]),
  ]
}

/**
 * 模块中间件合并进 config/middleware.ts 之前的检查：模块之间、模块与内置中间件的同名别名 / 分组会报错，
 * 除非项目的 config/middleware.ts 显式声明了同名项（视为有意覆盖）
 */
export function moduleMiddlewareConfig(modules: readonly ResolvedModule[], app: MiddlewareConfig | undefined): Required<Pick<MiddlewareConfig, 'alias' | 'groups'>> {
  const alias: NonNullable<MiddlewareConfig['alias']> = {}
  const groups: NonNullable<MiddlewareConfig['groups']> = {}
  const owners = new Map<string, string>()
  const claim = (kind: 'alias' | 'group', key: string, owner: string): boolean => {
    const overridden = kind === 'alias'
      ? app?.alias && key in app.alias
      : app?.groups && key in app.groups
    if (overridden)
      return false
    const id = `${kind}:${key}`
    const previous = owners.get(id) ?? (kind === 'alias' && key in builtinMiddleware
      ? 'the built-in middleware'
      : undefined)
    if (previous)
      throw new Error(`Middleware ${kind} "${key}" is defined by both ${previous} and ${owner}. Rename one, or override it in config/middleware.ts`)
    owners.set(id, owner)
    return true
  }
  for (const module of modules) {
    const owner = `module "${module.name}"`
    const middleware = module.definition.middleware
    for (const [key, handler] of Object.entries(middleware?.alias ?? {})) {
      if (claim('alias', key, owner))
        alias[key] = handler
    }
    for (const [key, refs] of Object.entries(middleware?.groups ?? {})) {
      if (claim('group', key, owner))
        groups[key] = refs
    }
  }
  return { alias, groups }
}

/** 模块的默认配置（函数形式在此求值） */
export function moduleConfig(module: ResolvedModule): Array<[string, Record<string, any>]> {
  return Object.entries(module.definition.config ?? {}).map(([key, value]) => [
    key,
    resolveConfigInput(value),
  ])
}

const LOCAL_RE = /(?:^|\/)modules\/([^/]+)\/(module|(route|config|schedule)\/([^/]+)|app\/([^/]+)\/(.+))\.[cm]?[jt]sx?$/

/** app/<dir>/ → 定义字段 */
const APP_DIRS: Record<string, keyof ModuleDefinition | `discovered.${string}`> = {
  provider: 'providers',
  interceptor: 'interceptors',
  policy: 'policies',
  job: 'jobs',
  event: 'events',
  listener: 'listeners',
  notification: 'notifications',
  channel: 'channels',
  command: 'commands',
  socket: 'discovered.sockets',
  message: 'discovered.messages',
}

/**
 * 按模块名分组 `modules/<name>/` 下发现的文件（与项目相同的目录约定）：
 * route/、config/（config/middleware.ts 为模块的中间件声明）、schedule/、
 * app/{provider,interceptor,policy,job,event,listener,notification,channel,command,socket,message}/，
 * 以及可选的 module.ts（defineModule 覆盖约定）。各类定义保留文件路径，文件名命名的规则不变
 */
export function groupLocalModules(record: ModuleRecord | undefined): Map<string, ModuleDefinition<any>> {
  const files = new Map<string, Record<string, ModuleRecord>>()
  const overrides = new Map<string, ModuleDefinition<any>>()
  const middleware = new Map<string, ConfigInput<ModuleMiddleware>>()
  for (const [path, mod] of Object.entries(record ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
    const match = LOCAL_RE.exec(path)
    if (!match)
      continue
    const [, name, , top, file, dir] = match
    const fields = files.get(name) ?? {}
    files.set(name, fields)
    const put = (field: string): void => {
      (fields[field] ??= {})[path] = mod
    }
    if (match[2] === 'module') {
      const value = unwrapDefault<unknown>(mod)
      if (!isHazeModule(value))
        throw new TypeError(`modules/${name}/module.ts must export default defineModule({ ... })`)
      const definition = value[kModule]
      if (definition.name && definition.name !== name)
        throw new Error(`modules/${name}/module.ts declares name "${definition.name}"; a local module is named after its directory`)
      overrides.set(name, definition)
    }
    else if (top === 'route') {
      put('routes')
    }
    else if (top === 'schedule') {
      put('schedules')
    }
    else if (top === 'config') {
      if (file === 'middleware')
        middleware.set(name, unwrapDefault(mod))
      else
        put('config')
    }
    else if (dir && APP_DIRS[dir]) {
      // 命令可以放在子目录（db/Prune.ts → db:prune），其它目录只取第一层
      if (dir !== 'command' && match[6].includes('/'))
        continue
      put(APP_DIRS[dir])
    }
  }

  const result = new Map<string, ModuleDefinition<any>>()
  for (const name of new Set([
    ...files.keys(),
    ...overrides.keys(),
    ...middleware.keys(),
  ])) {
    const fields = files.get(name) ?? {}
    const definition: ModuleDefinition<any> = { name }
    for (const [field, items] of Object.entries(fields)) {
      if (field === 'config') {
        definition.config = Object.fromEntries(normalizeModules<ConfigInput<Record<string, any>>>(items).map(([key, value]) => [key!, value]))
      }
      else if (field.startsWith('discovered.')) {
        (definition.discovered ??= {})[field.slice('discovered.'.length)] = items
      }
      else {
        (definition as Record<string, unknown>)[field] = items
      }
    }
    const declared = middleware.get(name)
    if (declared)
      definition.middleware = resolveConfigInput(declared)
    const override = overrides.get(name)
    result.set(name, override
      ? {
          ...mergeDefinitions(definition, { ...override, name }),
          options: override.options,
        }
      : definition)
  }
  return result
}
