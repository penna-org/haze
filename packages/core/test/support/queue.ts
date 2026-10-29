import type { Application, JobDefinition } from '../../src'
import process from 'node:process'
import { afterEach } from 'vitest'
import { createApplication } from '../../src'

export const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

export const redisUrl = process.env.HAZE_TEST_REDIS_URL

/** 等待条件成立（超时抛错） */
export async function waitFor(check: () => boolean | Promise<boolean>, timeout = 15_000): Promise<void> {
  const start = Date.now()
  while (!(await check())) {
    if (Date.now() - start > timeout)
      throw new Error('Timed out')
    await sleep(20)
  }
}

const current: Application[] = []

afterEach(async () => {
  for (const app of current.splice(0))
    await app.dispose()
})

/** 启动只带任务的应用（测试结束时自动关闭）；config 合并到应用配置 */
export async function bootQueue(jobs: JobDefinition<any>[], config: Record<string, unknown> = {}): Promise<Application> {
  const app = await createApplication({
    mode: 'test',
    env: false,
    jobs: Object.fromEntries(jobs.map(job => [
      `/app/job/${job.name}.ts`,
      { default: job },
    ])),
    config: {
      logger: { level: 'silent' },
      ...config,
    },
  })
  current.push(app)
  return app
}

/** 真实 Redis 上的队列与缓存（每次使用新的前缀，互不干扰） */
export function redisConfig(): Record<string, unknown> {
  const prefix = `test-${crypto.randomUUID()}`
  return {
    queue: {
      default: 'redis',
      store: 'redis',
      connections: {
        redis: {
          driver: 'redis',
          url: redisUrl,
          prefix,
          queues: ['default'],
        },
      },
    },
    cache: {
      default: 'redis',
      prefix: `${prefix}:`,
      stores: {
        redis: { driver: 'redis', url: redisUrl },
      },
    },
  }
}
