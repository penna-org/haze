import type { FailedJob, JobMessage } from '../job'
import type { ConsumeOptions, QueueDriver } from './types'
import { definePersistent } from '../../persistent'

interface MemoryState {
  ready: Map<string, JobMessage[]>
  delayed: Set<ReturnType<typeof setTimeout>>
  failed: FailedJob[]
}

/**
 * 进程内队列：投递后在本进程消费（自动开始，默认并发 1），延迟任务用计时器。
 * 进程退出即丢失，适合开发、测试与单实例的轻量任务。
 */
export function memoryQueue(name: string): QueueDriver & { idle: () => Promise<void> } {
  const state = definePersistent(`queue:memory:${name}`, (): MemoryState => ({
    ready: new Map(),
    delayed: new Set(),
    failed: [],
  }), {
    dispose: (value) => {
      value.delayed.forEach(timer => clearTimeout(timer))
      value.delayed.clear()
    },
  })
  let consumer: ConsumeOptions | undefined
  let active = 0
  let waiters: Array<() => void> = []

  function enqueue(message: JobMessage): void {
    const list = state.ready.get(message.queue) ?? []
    list.push(message)
    state.ready.set(message.queue, list)
    pump()
  }

  function settle(): void {
    const pending = [
      ...state.ready.values(),
    ].some(list => list.length)
    if (!active && !pending && !state.delayed.size) {
      waiters.forEach(resolve => resolve())
      waiters = []
    }
  }

  function pump(): void {
    if (!consumer)
      return
    while (active < consumer.concurrency) {
      const queue = consumer.queues.find(name => state.ready.get(name)?.length) ?? [
        ...state.ready.keys(),
      ].find(name => state.ready.get(name)?.length)
      if (!queue)
        break
      const message = state.ready.get(queue)!.shift()!
      active++
      void run(consumer, message).finally(() => {
        active--
        pump()
        settle()
      })
    }
    settle()
  }

  async function run(options: ConsumeOptions, message: JobMessage): Promise<void> {
    const attempt = message.attempts + 1
    const result = await options.process(message, attempt)
    if (result.status === 'retry') {
      later({ ...message, attempts: attempt }, result.delay)
    }
    else if (result.status === 'failed') {
      state.failed.push({
        id: message.id,
        job: message.job,
        queue: message.queue,
        payload: message.payload,
        error: String((result.error as Error)?.stack ?? result.error),
        attempts: attempt,
        failedAt: Date.now(),
      })
    }
  }

  function later(message: JobMessage, delaySeconds: number): void {
    if (delaySeconds <= 0)
      return enqueue(message)
    const timer = setTimeout(() => {
      state.delayed.delete(timer)
      enqueue(message)
    }, delaySeconds * 1000)
    state.delayed.add(timer)
  }

  return {
    driver: 'memory',
    async push(message, delaySeconds) {
      later(message, delaySeconds)
    },
    async consume(options) {
      consumer = { ...options, concurrency: options.concurrency || 1 }
      pump()
      return async () => {
        consumer = undefined
        // 等待执行中的任务完成
        await new Promise<void>((resolve) => {
          const check = (): void => {
            if (active === 0)
              resolve()
            else
              setTimeout(check, 10)
          }
          check()
        })
      }
    },
    async failed() {
      return [...state.failed]
    },
    async retry(id) {
      const jobs = state.failed.filter(job => id === undefined || job.id === id)
      state.failed = state.failed.filter(job => !jobs.includes(job))
      jobs.forEach(job => enqueue({
        id: job.id,
        job: job.job,
        payload: job.payload,
        queue: job.queue,
        attempts: 0,
        dispatchedAt: Date.now(),
      }))
      return jobs.length
    },
    async forget(id) {
      const before = state.failed.length
      state.failed = state.failed.filter(job => job.id !== id)
      return state.failed.length < before
    },
    async flush() {
      const count = state.failed.length
      state.failed = []
      return count
    },
    async counts() {
      return {
        waiting: [
          ...state.ready.values(),
        ].reduce((sum, list) => sum + list.length, 0),
        delayed: state.delayed.size,
        active,
        failed: state.failed.length,
      }
    },
    async close() {
      consumer = undefined
    },
    /** 等待队列清空（包括延迟任务与执行中的任务） */
    idle() {
      return new Promise<void>((resolve) => {
        waiters.push(resolve)
        settle()
      })
    },
  }
}
