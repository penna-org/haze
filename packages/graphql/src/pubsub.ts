/**
 * 进程内的发布 / 订阅，供订阅字段的 subscribe 使用：
 *
 * ```ts
 * export const pubsub = createPubSub<{ postAdded: Post }>()
 * // Subscription: { postAdded: { subscribe: () => pubsub.subscribe('postAdded'), resolve: post => post } }
 * // 发布：pubsub.publish('postAdded', post)
 * ```
 *
 * 只在本进程内有效；多实例部署时请在发布端经 Redis 等广播后再调用 publish。
 */
export interface PubSub<Events extends Record<string, unknown>> {
  publish: <K extends keyof Events & string>(topic: K, payload: Events[K]) => void
  subscribe: <K extends keyof Events & string>(topic: K, options?: {
    filter?: (payload: Events[K]) => boolean | Promise<boolean>
    /** 覆盖 createPubSub 的 maxBufferSize */
    maxBufferSize?: number
  }) => AsyncIterableIterator<Events[K]>
  /** 当前订阅数 */
  listenerCount: (topic?: keyof Events & string) => number
}

export interface PubSubOptions {
  /**
   * 每个订阅者未被消费的事件的缓冲上限，默认 1000。消费跟不上发布（如客户端网络很慢）时，
   * 超出部分丢弃最旧的事件，避免缓冲无限增长；Infinity 关闭上限。
   */
  maxBufferSize?: number
}

export function createPubSub<Events extends Record<string, unknown> = Record<string, unknown>>(settings: PubSubOptions = {}): PubSub<Events> {
  const listeners = new Map<string, Set<(payload: unknown) => void>>()

  return {
    publish(topic, payload) {
      for (const listener of [
        ...listeners.get(topic) ?? [],
      ])
        listener(payload)
    },
    subscribe(topic, options = {}) {
      type T = Events[typeof topic]
      const buffer: T[] = []
      const waiting: Array<(result: IteratorResult<T>) => void> = []
      const limit = options.maxBufferSize ?? settings.maxBufferSize ?? 1000
      let done = false
      const push = (payload: unknown): void => {
        void Promise.resolve(options.filter
          ? options.filter(payload as T)
          : true).then((pass) => {
          if (!pass || done)
            return
          const next = waiting.shift()
          if (next)
            next({ value: payload as T, done: false })
          else if (limit > 0 && buffer.push(payload as T) > limit)
            buffer.shift()
        })
      }
      let set = listeners.get(topic)
      if (!set)
        listeners.set(topic, set = new Set())
      set.add(push)

      const stop = (): void => {
        done = true
        set.delete(push)
        if (!set.size)
          listeners.delete(topic)
        buffer.length = 0
        for (const resolve of waiting.splice(0))
          resolve({ value: undefined, done: true })
      }

      const iterator: AsyncIterableIterator<T> = {
        next() {
          if (buffer.length) {
            return Promise.resolve({
              value: buffer.shift()!,
              done: false,
            })
          }
          if (done)
            return Promise.resolve({ value: undefined, done: true })
          return new Promise(resolve => waiting.push(resolve))
        },
        return() {
          stop()
          return Promise.resolve({ value: undefined, done: true })
        },
        throw(error) {
          stop()
          return Promise.reject(error)
        },
        [Symbol.asyncIterator]() {
          return iterator
        },
      }
      return iterator
    },
    listenerCount(topic) {
      if (topic !== undefined)
        return listeners.get(topic)?.size ?? 0
      let count = 0
      for (const set of listeners.values())
        count += set.size
      return count
    },
  }
}
