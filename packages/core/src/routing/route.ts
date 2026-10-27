import type { HttpContext, ValidationTargets } from '../http/context'
import type { MiddlewareRef } from '../middleware/types'
import type { Constructor } from '../utils'

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS'
export type RouteMethod = HttpMethod | 'ALL'

export type HandlerFn = (ctx: HttpContext<any>) => unknown

type MethodKeys<T> = {
  [K in keyof T]: T[K] extends (...args: any[]) => any ? K : never
}[keyof T] & string

/** `[UserController, 'show']`：可跳转、可重构，方法名受类型检查 */
export type ControllerAction<C extends Constructor = Constructor> = readonly [C, MethodKeys<InstanceType<C>>]

export type RouteHandler = HandlerFn | ControllerAction<any>

export interface RouteMeta {
  /** 设为 false 时不包装统一响应格式 */
  envelope?: boolean
  [key: string]: unknown
}

export interface RouteDefinition {
  method: RouteMethod
  path: string
  handler: RouteHandler
  middleware: MiddlewareRef[]
  name?: string
  validate?: ValidationTargets
  meta: RouteMeta
}

export function isControllerAction(handler: RouteHandler): handler is ControllerAction<any> {
  return Array.isArray(handler)
}

export class Route {
  readonly definition: RouteDefinition
  readonly #namePrefix: string

  constructor(definition: RouteDefinition, namePrefix = '') {
    this.definition = definition
    this.#namePrefix = namePrefix
  }

  /** 命名路由，可通过 `router.url(name, params)` 生成地址 */
  name(name: string): this {
    this.definition.name = this.#namePrefix + name
    return this
  }

  middleware(...refs: Array<MiddlewareRef | MiddlewareRef[]>): this {
    this.definition.middleware.push(...refs.flat())
    return this
  }

  /** 声明式校验，结果写入 `ctx.validated` */
  validate(schemas: ValidationTargets): this {
    this.definition.validate = {
      ...this.definition.validate,
      ...schemas,
    }
    return this
  }

  meta(meta: RouteMeta): this {
    Object.assign(this.definition.meta, meta)
    return this
  }
}
