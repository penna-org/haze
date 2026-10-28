import type { Auth, HttpContext, InjectionKey, MaybePromise } from '@hazejs/core'
import type { Loader, LoaderDefinition } from './loader'
import { createLoader } from './loader'

/**
 * 解析器的上下文。可通过声明合并补充 `context()` 返回的字段：
 *
 * ```ts
 * declare module '@hazejs/graphql' {
 *   interface GraphQLContext { tenant: string }
 * }
 * ```
 */
export interface GraphQLContext {
  /** hazejs 请求上下文（订阅中为连接建立时的上下文） */
  readonly http: HttpContext
  /** 等同 `http.auth` */
  readonly auth: Auth
  /** 等同 `http.can()` */
  readonly can: HttpContext['can']
  /** 等同 `http.authorize()`，未授权时抛出 403 */
  readonly authorize: HttpContext['authorize']
  /** 从请求容器解析依赖（订阅等请求之外的场景也可使用） */
  readonly inject: <T>(key: InjectionKey<T>) => T
  /** 当前请求的 Loader 实例（同一个定义在一次请求中只创建一次） */
  readonly loader: <K, V, C = K>(definition: LoaderDefinition<K, V, C>) => Loader<K, V>
}

/** 额外的上下文字段（graphqlHandler / graphqlProvider 的 context 选项） */
export type ContextFactory = (ctx: HttpContext) => MaybePromise<Record<string, unknown> | void>

export async function createContext(http: HttpContext, factory?: ContextFactory, extra?: Record<string, unknown>): Promise<GraphQLContext> {
  const loaders = new Map<LoaderDefinition<any, any, any>, Loader<any, any>>()
  const base: GraphQLContext = {
    http,
    get auth() {
      return http.auth
    },
    can: http.can.bind(http) as HttpContext['can'],
    authorize: http.authorize.bind(http) as HttpContext['authorize'],
    inject: key => http.make(key),
    loader(definition) {
      let loader = loaders.get(definition)
      if (!loader) {
        loader = createLoader(definition)
        loaders.set(definition, loader)
      }
      return loader
    },
  }
  const fields = await factory?.(http)
  // 保留 auth 的 getter
  return Object.defineProperties(base, Object.getOwnPropertyDescriptors({
    ...extra,
    ...fields,
  }))
}
