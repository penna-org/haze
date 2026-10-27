import type { Application } from '../application'
import type { EventDefinition, ListenerDefinition, ListenerHandler } from './event'
import { defineJob } from '../queue/job'
import { QueueManager } from '../queue/manager'
import { useEventManager } from './context'
import { isEvent, isListener } from './event'

interface RegisteredListener {
  name: string
  definition: ListenerDefinition<any>
}

export interface EmittedEvent {
  event: string
  payload: unknown
}

/** Events.fake()：记录触发而不执行监听器 */
export class EventFake {
  readonly emitted: Array<EmittedEvent & { definition: EventDefinition<any> }> = []

  constructor(private readonly manager: EventManager, readonly only?: EventDefinition<any>[]) {}

  fakes(event: EventDefinition<any>): boolean {
    return !this.only || this.only.includes(event)
  }

  #matching<P>(event: EventDefinition<P>, predicate?: (payload: P) => boolean): unknown[] {
    return this.emitted.filter(item => item.definition === event && (!predicate || predicate(item.payload as P))).map(item => item.payload)
  }

  assertEmitted<P>(event: EventDefinition<P>, predicate?: (payload: P) => boolean): void {
    if (!this.#matching(event, predicate).length)
      throw new Error(`Expected event "${this.manager.nameOf(event)}" to be emitted${predicate ? ' with a matching payload' : ''}`)
  }

  assertNotEmitted<P>(event: EventDefinition<P>, predicate?: (payload: P) => boolean): void {
    if (this.#matching(event, predicate).length)
      throw new Error(`Unexpected event "${this.manager.nameOf(event)}"`)
  }

  assertEmittedTimes<P>(event: EventDefinition<P>, times: number): void {
    const count = this.#matching(event).length
    if (count !== times)
      throw new Error(`Expected event "${this.manager.nameOf(event)}" to be emitted ${times} time(s), got ${count}`)
  }
}

/** 事件管理（应用单例，`inject(EventManager)`）：事件与监听器注册、触发 */
export class EventManager {
  readonly #names = new WeakMap<EventDefinition<any>, string>()
  readonly #listeners = new Map<EventDefinition<any>, RegisteredListener[]>()
  #fake: EventFake | undefined

  constructor(readonly app: Application) {}

  /** 注册事件（app/event 自动注册，用于命名） */
  registerEvent(event: unknown, name?: string): this {
    if (!isEvent(event))
      throw new TypeError('app/event/*.ts must export default defineEvent(...)')
    const eventName = event.name ?? name
    if (eventName)
      this.#names.set(event, eventName)
    return this
  }

  /** 注册监听器（app/listener 自动注册）；排队监听器同时注册为队列任务 `listener:<name>` */
  registerListener(listener: unknown, name?: string): this {
    if (!isListener(listener))
      throw new TypeError('app/listener/*.ts must export default defineListener(...)')
    const listenerName = listener.name ?? name ?? `listener${this.#listeners.size}`
    for (const event of listener.events) {
      const list = this.#listeners.get(event) ?? []
      list.push({ name: listenerName, definition: listener })
      this.#listeners.set(event, list)
    }
    const queue = listener.options.queue
    if (queue) {
      const options = queue === true
        ? {}
        : queue
      this.app.make(QueueManager).register(defineJob({
        name: `listener:${listenerName}`,
        tries: options.tries,
        backoff: options.backoff,
        timeout: options.timeout,
        queue: options.queue,
        connection: options.connection,
        handle: ({ event, payload }: { event: string, payload: unknown }, job) =>
          listener.handle(payload, {
            event,
            app: this.app,
            logger: job.logger,
            attempt: job.attempt,
          }),
      }))
    }
    return this
  }

  /** 运行时注册同步监听器（服务提供者中使用），返回取消函数 */
  on<P>(event: EventDefinition<P>, handle: ListenerHandler<P>): () => void {
    const entry: RegisteredListener = {
      name: `runtime:${handle.name || 'anonymous'}`,
      definition: {
        events: [event],
        handle,
        options: {},
      } as unknown as ListenerDefinition<P>,
    }
    const list = this.#listeners.get(event) ?? []
    list.push(entry)
    this.#listeners.set(event, list)
    return () => {
      const current = this.#listeners.get(event) ?? []
      this.#listeners.set(event, current.filter(item => item !== entry))
    }
  }

  nameOf(event: EventDefinition<any>): string {
    return this.#names.get(event) ?? event.name ?? 'anonymous'
  }

  listeners(event: EventDefinition<any>): string[] {
    return (this.#listeners.get(event) ?? []).map(item => item.name)
  }

  /** 触发：同步监听器按注册顺序执行（返回 false 时停止），排队监听器投递到队列 */
  async emit<P>(event: EventDefinition<P>, payload: P): Promise<void> {
    const name = this.nameOf(event)
    if (this.#fake?.fakes(event)) {
      this.#fake.emitted.push({ event: name, payload, definition: event })
      return
    }
    const logger = this.app.logger.child({ event: name })
    for (const { name: listener, definition } of this.#listeners.get(event) ?? []) {
      const queue = definition.options.queue
      if (queue) {
        const delay = queue === true
          ? undefined
          : queue.delay
        await this.app.make(QueueManager).dispatch(`listener:${listener}`, { event: name, payload }, { delay })
        continue
      }
      const result = await definition.handle(payload, {
        event: name,
        app: this.app,
        logger,
        attempt: 1,
      })
      if (result === false)
        break
    }
  }

  /** 记录触发而不执行监听器；传入事件时只 fake 这些事件 */
  fake(events?: EventDefinition<any>[]): EventFake {
    this.#fake = new EventFake(this, events)
    return this.#fake
  }

  restore(): void {
    this.#fake = undefined
  }
}

/**
 * 事件门面（避免与全局的 Event 类型重名）：
 *
 * ```ts
 * await Events.emit(UserRegistered, { userId: 1 })
 * const fake = Events.fake()
 * ```
 */
export const Events = {
  emit: <P>(event: EventDefinition<P>, payload: P): Promise<void> => useEventManager().emit(event, payload),
  on: <P>(event: EventDefinition<P>, handle: ListenerHandler<P>): (() => void) => useEventManager().on(event, handle),
  fake: (events?: EventDefinition<any>[]): EventFake => useEventManager().fake(events),
  restore: (): void => useEventManager().restore(),
}
