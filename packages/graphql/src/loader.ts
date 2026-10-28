import process from 'node:process'

/**
 * 批量加载（DataLoader 风格，无依赖）：同一轮事件循环中的 load() 合并为一次 batch 调用，
 * 解决 N+1 查询；结果按键缓存（每个请求一个 Loader 实例，避免跨请求缓存）。
 */

/** 批量函数：按 keys 的顺序返回值数组（某项可为 Error），或返回 `Map<key, value>` */
export type BatchFn<K, V> = (keys: readonly K[]) => Promise<ReadonlyArray<V | Error> | ReadonlyMap<K, V>> | ReadonlyArray<V | Error> | ReadonlyMap<K, V>

export interface LoaderOptions<K, C = K> {
  /** 单次 batch 的最大键数，默认不限 */
  maxBatchSize?: number
  /** 是否缓存结果，默认 true */
  cache?: boolean
  /** 缓存键（对象键可转为字符串），默认键本身 */
  cacheKey?: (key: K) => C
  /** 自定义调度（默认在当前微任务队列清空后执行） */
  schedule?: (dispatch: () => void) => void
}

export interface Loader<K, V> {
  load: (key: K) => Promise<V>
  loadMany: (keys: readonly K[]) => Promise<Array<V | Error>>
  /** 预先写入缓存 */
  prime: (key: K, value: V | Error) => this
  clear: (key: K) => this
  clearAll: () => this
}

const kLoader = Symbol.for('hazejs.graphql.loader')

/** 可复用的 Loader 定义：在解析器中用 `ctx.loader(definition)` 取得当前请求的实例 */
export interface LoaderDefinition<K, V, C = K> {
  readonly [kLoader]: true
  readonly batch: BatchFn<K, V>
  readonly options: LoaderOptions<K, C>
}

/**
 * 定义 Loader（模块顶层）：
 *
 * ```ts
 * export const UserById = defineLoader(async (ids: readonly number[]) => {
 *   const users = await User.query().whereIn('id', ids).get()
 *   return new Map(users.map(user => [user.id, user]))
 * })
 * // 解析器：author: (post, _, ctx) => ctx.loader(UserById).load(post.authorId)
 * ```
 */
export function defineLoader<K, V, C = K>(batch: BatchFn<K, V>, options: LoaderOptions<K, C> = {}): LoaderDefinition<K, V, C> {
  return { [kLoader]: true, batch, options }
}

export function isLoaderDefinition(value: unknown): value is LoaderDefinition<unknown, unknown> {
  return typeof value === 'object' && value !== null && kLoader in value
}

/** 微任务清空后再执行，使同一轮中分散在多个 Promise 回调里的 load() 也能合并 */
function defaultSchedule(dispatch: () => void): void {
  void Promise.resolve().then(() => process.nextTick(dispatch))
}

interface Batch<K, V> {
  keys: K[]
  callbacks: Array<{ resolve: (value: V) => void, reject: (error: unknown) => void }>
}

/** 创建 Loader 实例：`createLoader(batchFn, options)` 或 `createLoader(definition)` */
export function createLoader<K, V, C = K>(batchOrDefinition: BatchFn<K, V> | LoaderDefinition<K, V, C>, maybeOptions: LoaderOptions<K, C> = {}): Loader<K, V> {
  const { batch: batchFn, options } = isLoaderDefinition(batchOrDefinition)
    ? batchOrDefinition as LoaderDefinition<K, V, C>
    : { batch: batchOrDefinition as BatchFn<K, V>, options: maybeOptions }
  const schedule = options.schedule ?? defaultSchedule
  const cacheKey = options.cacheKey ?? ((key: K) => key as unknown as C)
  const useCache = options.cache !== false
  const cache = new Map<C, Promise<V>>()
  let current: Batch<K, V> | undefined

  const dispatch = async (batch: Batch<K, V>): Promise<void> => {
    try {
      const result = await batchFn(batch.keys)
      if (result instanceof Map) {
        batch.keys.forEach((key, index) => batch.callbacks[index].resolve(result.get(key) as V))
        return
      }
      const values = result as ReadonlyArray<V | Error>
      if (!Array.isArray(values) || values.length !== batch.keys.length) {
        throw new TypeError(`Loader batch function must return an array of the same length as the keys (${batch.keys.length}) or a Map, got ${Array.isArray(values)
          ? values.length
          : typeof values}`)
      }
      values.forEach((value, index) => value instanceof Error
        ? batch.callbacks[index].reject(value)
        : batch.callbacks[index].resolve(value))
    }
    catch (error) {
      // 整批失败：不缓存失败结果，之后可重试
      batch.keys.forEach((key, index) => {
        cache.delete(cacheKey(key))
        batch.callbacks[index].reject(error)
      })
    }
  }

  const enqueue = (key: K): Promise<V> => new Promise<V>((resolve, reject) => {
    if (!current || (options.maxBatchSize && current.keys.length >= options.maxBatchSize)) {
      const batch: Batch<K, V> = { keys: [], callbacks: [] }
      current = batch
      schedule(() => {
        if (current === batch)
          current = undefined
        void dispatch(batch)
      })
    }
    current.keys.push(key)
    current.callbacks.push({ resolve, reject })
  })

  const loader: Loader<K, V> = {
    load(key) {
      if (!useCache)
        return enqueue(key)
      const id = cacheKey(key)
      let promise = cache.get(id)
      if (!promise) {
        promise = enqueue(key)
        cache.set(id, promise)
      }
      return promise
    },
    loadMany(keys) {
      return Promise.all(keys.map(key => loader.load(key).catch((error: unknown) => error instanceof Error
        ? error
        : new Error(String(error)))))
    },
    prime(key, value) {
      const id = cacheKey(key)
      if (useCache && !cache.has(id)) {
        const promise = value instanceof Error
          ? Promise.reject(value)
          : Promise.resolve(value)
        promise.catch(() => {})
        cache.set(id, promise)
      }
      return loader
    },
    clear(key) {
      cache.delete(cacheKey(key))
      return loader
    },
    clearAll() {
      cache.clear()
      return loader
    },
  }
  return loader
}
