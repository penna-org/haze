import type { H3 } from 'h3'
import type { Container } from '../container/container'
import type { MiddlewareRegistry } from '../middleware/registry'
import type { MiddlewareRef } from '../middleware/types'
import type { Constructor } from '../utils'
import type { RouteModule, RouteRegistrar } from './builder'
import type { Route, RouteDefinition, RouteHandler } from './route'
import type { SignedUrlOptions } from './signed'
import { Config } from '../config/config'
import { Scope, scopeOf } from '../container/container'
import { getHttpContext } from '../http/context'
import { validateRequest } from '../http/validation'
import { getRequestStore } from '../request'
import { isPlainObject, joinPath } from '../utils'
import { isRouteModule, RouteBuilder } from './builder'
import { isControllerAction } from './route'
import { signUrl } from './signed'

/** 控制器级中间件声明：`static middleware = ['auth', { use: 'log', only: ['store'] }]` */
export interface ControllerMiddleware {
  use: MiddlewareRef | MiddlewareRef[]
  only?: string[]
  except?: string[]
}

/**
 * 命名路由及其参数，由 `haze typegen`（开发服务器自动执行）生成：
 * `'api.users.show': { id: string | number }`
 */
export interface RouteNames {}

type KnownRoute = keyof RouteNames & string
/** 生成过类型后只接受已定义的路由名，否则为 string */
export type RouteName = [KnownRoute] extends [never] ? string : KnownRoute
type Query = Record<string, string | number>
type UrlArgs<N> = N extends KnownRoute
  ? [keyof RouteNames[N]] extends [never]
      ? [params?: Record<string, never>, query?: Query]
      : [params: RouteNames[N], query?: Query]
  : [params?: Record<string, string | number>, query?: Query]
type SignedUrlArgs<N> = N extends KnownRoute
  ? [keyof RouteNames[N]] extends [never]
      ? [params?: Record<string, never>, options?: SignedUrlOptions]
      : [params: RouteNames[N], options?: SignedUrlOptions]
  : [params?: Record<string, string | number>, options?: SignedUrlOptions]

export interface RouteInfo {
  method: string
  path: string
  /** 所属应用（多应用模式） */
  app?: string
  /** 绑定的域名（多应用模式） */
  domain?: string
  /** 注册该路由的模块 */
  module?: string
  name?: string
  handler: string
  middleware: string[]
}

/** 路由表条目及其定义（校验 schema、文档信息），供 OpenAPI 与类型生成读取 */
export interface RouteRecord extends RouteInfo {
  definition: RouteDefinition
}

export interface CompileOptions {
  h3: H3
  container: Container
  middleware: MiddlewareRegistry
}

export interface LoadOptions {
  /** 路由名前缀（多应用时为 `<app>.`，模块默认为 `<模块名>.`） */
  as?: string
  /** URL 前缀 */
  prefix?: string
  /** 追加到这些路由上的中间件 */
  middleware?: MiddlewareRef[]
  /** 标记来源模块（route:list 的 MODULE 列、重名提示） */
  module?: string
}

export interface MountOptions {
  app: string
  /** URL 前缀，例如 `/admin`；仅绑定域名时为 `/` */
  prefix: string
  domain?: string[]
}

export class Router {
  readonly #routes: Route[] = []
  readonly #mounts: Array<{ router: Router } & MountOptions> = []
  #compiled: RouteRecord[] = []
  /** compile() 时记录，签名链接在请求之外读取 APP_KEY / APP_URL */
  #container: Container | undefined

  /** 加载路由模块；`as` 为路由名前缀（多应用时为 `<app>.`），模块的路由另带前缀与中间件 */
  load(module: RouteModule | RouteRegistrar, options: LoadOptions = {}): this {
    const register = isRouteModule(module)
      ? module.register
      : module
    const start = this.#routes.length
    register(new RouteBuilder(this.#routes, {
      prefix: options.prefix ?? '',
      middleware: [
        ...(options.middleware ?? []),
      ],
      as: options.as ?? '',
    }))
    if (options.module) {
      for (const route of this.#routes.slice(start))
        route.definition.module = options.module
    }
    return this
  }

  definitions(): readonly RouteDefinition[] {
    return this.#routes.map(route => route.definition)
  }

  /** 挂载子应用的路由表，使 list() / url() 覆盖所有应用 */
  mount(router: Router, options: MountOptions): this {
    const own = new Map(this.list().filter(route => route.name).map(route => [route.name, route]))
    const duplicate = router.list().find(route => route.name && own.has(route.name))
    if (duplicate)
      throw new Error(`Duplicate route name "${duplicate.name}" in app "${options.app}"${sources(own.get(duplicate.name)!.module, duplicate.module)}`)
    this.#mounts.push({ router, ...options })
    return this
  }

  /** 已编译的路由表（含展开后的中间件与所有子应用），用于 `route:list` */
  list(): readonly RouteInfo[] {
    return this.records().map(({ definition: _, ...info }) => info)
  }

  /** 与 list() 相同，但带有路由定义 */
  records(): readonly RouteRecord[] {
    return [
      ...this.#compiled,
      ...this.#mounts.flatMap(({ router, app, prefix, domain }) => router.records().map(route => ({
        ...route,
        path: joinPath(prefix, route.path),
        app,
        ...(domain && {
          domain: domain.join(', '),
        }),
      }))),
    ]
  }

  /** 根据路由名生成 URL：`router.url('users.show', { id: 1 })` */
  url<N extends RouteName>(name: N, ...args: UrlArgs<N>): string
  url(name: string, params: Record<string, string | number> = {}, query?: Query): string {
    const template = this.#pathOf(name)
    if (template === undefined)
      throw new Error(`Route "${name}" is not defined`)

    const path = template.replace(/:(\w+)/g, (_, key: string) => {
      if (params[key] === undefined)
        throw new Error(`Missing param "${key}" for route "${name}"`)
      return encodeURIComponent(String(params[key]))
    })
    const search = query
      ? new URLSearchParams(Object.entries(query).map(([k, v]): [string, string] => [
          k,
          String(v),
        ])).toString()
      : ''
    return search
      ? `${path}?${search}`
      : path
  }

  /**
   * 生成带签名的链接（HMAC-SHA256，密钥为 APP_KEY，覆盖路径与排序后的查询参数），
   * 配合 `signed` 中间件或 `ctx.hasValidSignature()` 校验；设置了 APP_URL 时为绝对链接：
   *
   * ```ts
   * await router.signedUrl('unsubscribe', { id: user.id })
   * await router.signedUrl('invitations.accept', { id }, { expiresIn: '7d' })
   * ```
   */
  signedUrl<N extends RouteName>(name: N, ...args: SignedUrlArgs<N>): Promise<string>
  signedUrl(name: string, params: Record<string, string | number> = {}, options: SignedUrlOptions = {}): Promise<string> {
    const { query, ...rest } = options
    return signUrl(this.url(name as RouteName, params as never), {
      ...rest,
      query,
      config: getRequestStore()?.ctx.config ?? this.#container?.make(Config),
    })
  }

  /** 带有效期的签名链接：`await router.temporarySignedUrl('downloads.show', '30m', { id })` */
  temporarySignedUrl<N extends RouteName>(name: N, expiresIn: string | number | Date, ...args: SignedUrlArgs<N>): Promise<string>
  temporarySignedUrl(name: string, expiresIn: string | number | Date, params: Record<string, string | number> = {}, options: SignedUrlOptions = {}): Promise<string> {
    return this.signedUrl(name as RouteName, params as never, {
      ...options,
      ...(expiresIn instanceof Date
        ? { expiresAt: expiresIn }
        : { expiresIn }),
    } as never)
  }

  #pathOf(name: string): string | undefined {
    const own = this.definitions().find(def => def.name === name)
    if (own)
      return own.path
    for (const mount of this.#mounts) {
      const path = mount.router.#pathOf(name)
      if (path !== undefined)
        return joinPath(mount.prefix, path)
    }
    return undefined
  }

  compile({ h3, container, middleware }: CompileOptions): void {
    this.#container = container
    const names = new Map<string, RouteDefinition>()
    this.#compiled = this.definitions().map((definition) => {
      if (definition.name) {
        const previous = names.get(definition.name)
        if (previous)
          throw new Error(`Duplicate route name "${definition.name}"${sources(previous.module, definition.module)}`)
        names.set(definition.name, definition)
      }

      const refs = [...definition.middleware]
      if (isControllerAction(definition.handler)) {
        const [controller, action] = definition.handler
        // 控制器默认请求作用域，可通过 static scope 覆盖
        if (!container.has(controller)) {
          container.bind(controller, controller, {
            scope: scopeOf(controller, Scope.Request),
          })
        }
        refs.push(...controllerMiddleware(controller, action))
      }

      const resolved = middleware.resolve(refs)
      h3.on(definition.method === 'ALL'
        ? ''
        : definition.method, definition.path, createHandler(definition), {
        middleware: resolved.map(item => middleware.toH3(item)),
        // 出站格式化时读取（例如 envelope: false）
        meta: { ...definition.meta, name: definition.name },
      })

      return {
        method: definition.method,
        path: definition.path,
        ...(definition.module && { module: definition.module }),
        name: definition.name,
        handler: handlerLabel(definition.handler),
        middleware: resolved.map(item => item.name),
        definition,
      }
    })
  }
}

/** 重名路由的来源说明（涉及模块时才附加） */
function sources(first: string | undefined, second: string | undefined): string {
  if (!first && !second)
    return ''
  const label = (module: string | undefined): string => module
    ? `module "${module}"`
    : 'the app'
  return ` (${label(first)} and ${label(second)})`
}

function createHandler(definition: RouteDefinition) {
  const { handler, validate } = definition

  return async (event: Parameters<typeof getHttpContext>[0]): Promise<unknown> => {
    const ctx = getHttpContext(event)!
    if (validate)
      await validateRequest(ctx, validate)

    let result: unknown
    if (isControllerAction(handler)) {
      const [controller, action] = handler
      const instance = ctx.container.make(controller) as Record<string, (ctx: unknown) => unknown>
      result = await instance[action](ctx)
    }
    else {
      result = await handler(ctx)
    }
    // 返回原始数据，统一格式在出站时由 ResponseFormatter 处理，中间件可在 next() 之后拿到原始值
    return result
  }
}

function controllerMiddleware(controller: Constructor, action: string): MiddlewareRef[] {
  const declared = (controller as { middleware?: Array<MiddlewareRef | ControllerMiddleware> }).middleware ?? []
  return declared.flatMap((item) => {
    if (!isPlainObject(item))
      return [item as MiddlewareRef]
    const { use, only, except } = item as unknown as ControllerMiddleware
    if (only && !only.includes(action))
      return []
    if (except?.includes(action))
      return []
    return Array.isArray(use)
      ? use
      : [use]
  })
}

function handlerLabel(handler: RouteHandler): string {
  if (isControllerAction(handler))
    return `${handler[0].name}@${handler[1]}`
  return handler.name || 'closure'
}
