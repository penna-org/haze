import type { ValidationTargets } from '../http/context'
import type { MiddlewareRef } from '../middleware/types'
import type { Constructor } from '../utils'
import type { WebSocketHandler } from '../websocket/handler'
import type { ControllerAction, HandlerFn, RouteMethod } from './route'
import { joinPath } from '../utils'
import { upgradeResponse } from '../websocket/handler'
import { isControllerAction, Route } from './route'

export interface GroupOptions {
  prefix?: string
  middleware?: MiddlewareRef[]
  /** 路由名前缀，例如 `admin.` */
  as?: string
}

export type ResourceAction = 'index' | 'store' | 'show' | 'update' | 'destroy'

export interface ResourceOptions {
  only?: ResourceAction[]
  except?: ResourceAction[]
  /** 路径参数名，默认 `id` */
  param?: string
  /** 路由名基础，默认取路径最后一段，例如 `users` */
  name?: string
}

interface Scope {
  prefix: string
  middleware: MiddlewareRef[]
  as: string
}

const RESOURCE_ACTIONS: ResourceAction[] = [
  'index',
  'store',
  'show',
  'update',
  'destroy',
]

type Handler<C extends Constructor> = HandlerFn | ControllerAction<C>

export class ResourceRoutes {
  readonly routes: Route[]
  /** 带 `:id` 参数的成员路由（show / update / destroy） */
  readonly members: Route[]

  constructor(routes: Route[], members: Route[]) {
    this.routes = routes
    this.members = members
  }

  middleware(...refs: Array<MiddlewareRef | MiddlewareRef[]>): this {
    this.routes.forEach(route => route.middleware(...refs))
    return this
  }

  /** 为成员路由声明校验，常用于校验并转换 `:id` */
  validateMember(schemas: ValidationTargets): this {
    this.members.forEach(route => route.validate(schemas))
    return this
  }
}

export class RouteBuilder {
  readonly #routes: Route[]
  readonly #scope: Scope

  constructor(routes: Route[], scope: Scope = { prefix: '', middleware: [], as: '' }) {
    this.#routes = routes
    this.#scope = scope
  }

  get<C extends Constructor>(path: string, handler: Handler<C>): Route {
    return this.#add('GET', path, handler)
  }

  post<C extends Constructor>(path: string, handler: Handler<C>): Route {
    return this.#add('POST', path, handler)
  }

  put<C extends Constructor>(path: string, handler: Handler<C>): Route {
    return this.#add('PUT', path, handler)
  }

  patch<C extends Constructor>(path: string, handler: Handler<C>): Route {
    return this.#add('PATCH', path, handler)
  }

  delete<C extends Constructor>(path: string, handler: Handler<C>): Route {
    return this.#add('DELETE', path, handler)
  }

  options<C extends Constructor>(path: string, handler: Handler<C>): Route {
    return this.#add('OPTIONS', path, handler)
  }

  /** 匹配所有 HTTP 方法 */
  any<C extends Constructor>(path: string, handler: Handler<C>): Route {
    return this.#add('ALL', path, handler)
  }

  /**
   * WebSocket：升级请求与普通 GET 一样经过全局与路由中间件（如 `.middleware('auth')`），
   * 通过后由 crossws 建立连接；钩子的最后一个参数为升级请求的上下文
   */
  ws(path: string, handler: WebSocketHandler): Route {
    return this.#add('GET', path, (ctx => upgradeResponse(ctx, handler)) as HandlerFn).meta({ websocket: true })
  }

  group(callback: (r: RouteBuilder) => void): void
  group(options: GroupOptions, callback: (r: RouteBuilder) => void): void
  group(optionsOrCallback: GroupOptions | ((r: RouteBuilder) => void), maybeCallback?: (r: RouteBuilder) => void): void {
    const [options, callback] = typeof optionsOrCallback === 'function'
      ? [{}, optionsOrCallback]
      : [optionsOrCallback, maybeCallback!]

    callback(new RouteBuilder(this.#routes, {
      prefix: joinPath(this.#scope.prefix, options.prefix ?? ''),
      middleware: [
        ...this.#scope.middleware,
        ...(options.middleware ?? []),
      ],
      as: this.#scope.as + (options.as ?? ''),
    }))
  }

  /**
   * RESTful 资源路由：
   *
   * | 方法        | 路径         | 动作    |
   * |-------------|--------------|---------|
   * | GET         | /users       | index   |
   * | POST        | /users       | store   |
   * | GET         | /users/:id   | show    |
   * | PUT / PATCH | /users/:id   | update  |
   * | DELETE      | /users/:id   | destroy |
   *
   * 未指定 `only` 时只注册控制器上实际存在的方法。
   */
  resource<C extends Constructor>(path: string, controller: C, options: ResourceOptions = {}): ResourceRoutes {
    const param = options.param ?? 'id'
    const base = options.name ?? path.split('/').filter(segment => segment && !segment.startsWith(':')).pop() ?? 'resource'
    const member = joinPath(path, `:${param}`)
    const hasMethod = (action: string): boolean => typeof controller.prototype[action] === 'function'

    let actions = options.only ?? RESOURCE_ACTIONS.filter(hasMethod)
    if (options.except)
      actions = actions.filter(action => !options.except!.includes(action))

    const missing = actions.filter(action => !hasMethod(action))
    if (missing.length)
      throw new Error(`Resource controller ${controller.name} is missing methods: ${missing.join(', ')}`)

    const routes: Route[] = []
    const members: Route[] = []
    const add = (method: RouteMethod, routePath: string, action: ResourceAction, named = true): void => {
      const route = this.#add(method, routePath, [controller, action] as unknown as ControllerAction<C>)
      if (named)
        route.name(`${base}.${action}`)
      routes.push(route)
      if (routePath === member)
        members.push(route)
    }

    const register: Record<ResourceAction, () => void> = {
      index: () => add('GET', path, 'index'),
      store: () => add('POST', path, 'store'),
      show: () => add('GET', member, 'show'),
      update: () => {
        add('PUT', member, 'update')
        add('PATCH', member, 'update', false)
      },
      destroy: () => add('DELETE', member, 'destroy'),
    }
    // 按固定顺序注册，与 only 中的书写顺序无关
    RESOURCE_ACTIONS.filter(action => actions.includes(action)).forEach(action => register[action]())
    return new ResourceRoutes(routes, members)
  }

  #add(method: RouteMethod, path: string, handler: HandlerFn | ControllerAction<any>): Route {
    if (isControllerAction(handler)) {
      const [controller, action] = handler
      if (typeof controller?.prototype?.[action] !== 'function')
        throw new TypeError(`Invalid route [${method}] ${path}: ${controller?.name ?? 'controller'}.${action} is not a method`)
    }
    else if (typeof handler !== 'function') {
      throw new TypeError(`Invalid route [${method}] ${path}: handler must be a function or [Controller, 'method']`)
    }

    const route = new Route({
      method,
      path: joinPath(this.#scope.prefix, path),
      handler,
      middleware: [...this.#scope.middleware],
      meta: {},
    }, this.#scope.as)
    this.#routes.push(route)
    return route
  }
}

const kRoutes = Symbol.for('think-h3.routes')

export type RouteRegistrar = (r: RouteBuilder) => void

export interface RouteModule {
  readonly [kRoutes]: true
  readonly register: RouteRegistrar
}

/** 定义路由文件（`route/*.ts` 的默认导出） */
export function defineRoutes(register: RouteRegistrar): RouteModule {
  return { [kRoutes]: true, register }
}

export function isRouteModule(value: unknown): value is RouteModule {
  return typeof value === 'object' && value !== null && kRoutes in value
}
