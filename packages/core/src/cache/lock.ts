import type { CacheStore } from './store'
import { toBase64Url } from '../security/key'

export class LockTimeoutException extends Error {
  override name = 'LockTimeoutException'
}

/**
 * 原子锁：`add`（不存在才写）获取，持有者校验后释放，过期自动释放。
 *
 * ```ts
 * await Cache.lock('report', '30s').run(async () => generate())   // 拿不到锁时抛 LockTimeoutException
 * const lock = Cache.lock('job', 60)
 * if (await lock.get()) { try { ... } finally { await lock.release() } }
 * ```
 */
export class Lock {
  /** 持有者标识：跨进程释放时用 Cache.restoreLock(name, owner) */
  readonly owner: string

  constructor(readonly store: CacheStore, readonly key: string, readonly seconds: number, owner?: string) {
    if (!store.atomic)
      throw new Error(`Cache driver "${store.driver}" does not support atomic locks`)
    this.owner = owner ?? toBase64Url(crypto.getRandomValues(new Uint8Array(16)))
  }

  /** 尝试获取，立即返回是否成功 */
  get(): Promise<boolean> {
    return this.store.add(this.key, this.owner, this.seconds)
  }

  /** 在 waitSeconds 内重试获取（默认每 250ms），超时抛 LockTimeoutException */
  async block(waitSeconds: number, interval = 250): Promise<void> {
    const deadline = Date.now() + waitSeconds * 1000
    while (!(await this.get())) {
      if (Date.now() >= deadline)
        throw new LockTimeoutException(`Could not acquire lock "${this.key}" within ${waitSeconds}s`)
      await new Promise(resolve => setTimeout(resolve, interval))
    }
  }

  /** 只有持有者才能释放，返回是否释放 */
  release(): Promise<boolean> {
    return this.store.deleteIf(this.key, this.owner)
  }

  /** 获取锁（可等待 waitSeconds）后执行，完成后释放 */
  async run<T>(fn: () => Promise<T> | T, waitSeconds = 0): Promise<T> {
    if (waitSeconds > 0)
      await this.block(waitSeconds)
    else if (!(await this.get()))
      throw new LockTimeoutException(`Lock "${this.key}" is held by another process`)
    try {
      return await fn()
    }
    finally {
      await this.release()
    }
  }
}
