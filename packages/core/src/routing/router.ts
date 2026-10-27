import type { H3 } from 'h3'
import type { ResponseConfig } from '../config/config'
import type { Container } from '../container/container'
import type { MiddlewareRegistry } from '../middleware/registry'
import type { MiddlewareRef } from '../middleware/types'
import type { Constructor } from '../utils'
import type { RouteModule, RouteRegistrar } from './builder'
import type { Route, RouteDefinition, RouteHandler } from './route'
import { Scope, scopeOf } from '../container/container'
import { getHttpContext } from '../http/context'
import { envelope } from '../http/response'
import { validateRequest } from '../http/validation'
import { isPlainObject } from '../utils'
import { isRouteModule, RouteBuilder } from './builder'
import { isControllerAction } from './route'

/** 控制器级中间件声明：`static middleware = ['auth', { use: 'log', only: ['store'] }]` */
export interface ControllerMiddleware {
  use: MiddlewareRef | MiddlewareRef[]
  only?: string[]
  except?: string[]
}

export interface RouteInfo {
  method: string
  path: string
  name?: string
  handler: string
  middleware: string[]
}

export interface CompileOptions {
  h3: H3
  container: Container
  middleware: MiddlewareRegistry
  response: ResponseConfig
}

export class Router {
  readonly #routes: Route[] = []
  #compiled: RouteInfo[] = []

  load(module: RouteModule | RouteRegistrar): this {
    const register = isRouteModule(module)
      ? module.register
      : module
    register(new RouteBuilder(this.#routes))
    return this
  }

  definitions(): readonly RouteDefinition[] {
    return this.#routes.map(route => route.definition)
  }

  /** 已编译的路由表（含展开后的中间件），用于 `route:list` */
  list(): readonly RouteInfo[] {
    return this.#compiled
  }

  /** 根据路由名生成 URL：`router.url('users.show', { id: 1 })` */
  url(name: string, params: Record<string, string | number> = {}, query?: Record<string, string | number>): string {
    const definition = this.definitions().find(def => def.name === name)
    if (!definition)
      throw new Error(`Route "${name}" is not defined`)

    const path = definition.path.replace(/:(\w+)/g, (_, key: string) => {
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

  compile({ h3, container, middleware, response }: CompileOptions): void {
    const names = new Set<string>()
    this.#compiled = this.definitions().map((definition) => {
      if (definition.name) {
        if (names.has(definition.name))
          throw new Error(`Duplicate route name "${definition.name}"`)
        names.add(definition.name)
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
        : definition.method, definition.path, createHandler(definition, response), {
        middleware: resolved.map(item => middleware.toH3(item)),
        meta: { name: definition.name },
      })

      return {
        method: definition.method,
        path: definition.path,
        name: definition.name,
        handler: handlerLabel(definition.handler),
        middleware: resolved.map(item => item.name),
      }
    })
  }
}

function createHandler(definition: RouteDefinition, response: ResponseConfig) {
  const { handler, validate } = definition
  const wrap = response.envelope && definition.meta.envelope !== false

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
    return wrap
      ? envelope(result, response)
      : result
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
