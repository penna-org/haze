import type { Middleware as H3Middleware } from 'h3'
import type { MiddlewareClass, MiddlewareConfig, MiddlewareHandler, MiddlewareRef } from './types'
import { getHttpContext } from '../http/context'
import { isClass } from '../utils'
import { builtinMiddleware } from './builtin'

export interface ResolvedMiddleware {
  name: string
  handler: MiddlewareHandler | MiddlewareClass
  args: string[]
}

export class MiddlewareRegistry {
  readonly #alias: Record<string, MiddlewareHandler | MiddlewareClass>
  readonly #groups: Record<string, MiddlewareRef[]>

  constructor(config: MiddlewareConfig = {}) {
    // 内置中间件（cors、throttle、auth 等）可被同名别名覆盖
    this.#alias = {
      ...builtinMiddleware,
      ...config.alias,
    }
    this.#groups = config.groups ?? {}
  }

  /** 展开别名与分组，返回扁平的中间件列表 */
  resolve(refs: MiddlewareRef[], expanding: string[] = []): ResolvedMiddleware[] {
    return refs.flatMap((ref) => {
      if (typeof ref !== 'string') {
        // 直接传入的函数 / 类按 `名称()` 显示：不与别名（auth、guest、can:…）混淆，OpenAPI 只按别名推断 401 / 403
        return [
          { name: `${ref.name || 'anonymous'}()`, handler: ref, args: [] },
        ]
      }

      const [name, rawArgs] = splitRef(ref)
      if (name in this.#groups) {
        if (expanding.includes(name))
          throw new Error(`Circular middleware group: ${[...expanding, name].join(' -> ')}`)
        return this.resolve(this.#groups[name], [...expanding, name])
      }
      const handler = this.#alias[name]
      if (!handler)
        throw new Error(`Unknown middleware "${name}". Register it in config/middleware.ts (alias or groups).`)
      return [
        { name: ref, handler, args: rawArgs },
      ]
    })
  }

  /** 转换为 h3 中间件；类中间件从当前请求容器解析，因此可注入依赖 */
  toH3({ handler, args }: ResolvedMiddleware): H3Middleware {
    const handle: MiddlewareHandler = isClass(handler)
      ? (ctx, next, ...rest) => ctx.container.make(handler).handle(ctx, next, ...rest)
      : handler as MiddlewareHandler

    return (event, next) => {
      const ctx = getHttpContext(event)!
      return handle(ctx, async () => next(), ...args)
    }
  }
}

function splitRef(ref: string): [name: string, args: string[]] {
  const index = ref.indexOf(':')
  if (index === -1)
    return [ref, []]
  return [
    ref.slice(0, index),
    ref.slice(index + 1).split(',').map(arg => arg.trim()),
  ]
}
