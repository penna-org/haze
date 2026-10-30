import type { Logger } from './logger'
import type { MaybePromise } from './utils'
import { getContextApp } from './request'

/**
 * 事务提交后执行的实现（由数据库包注册，如 @hazejs/orm）：当前异步上下文处于事务中时登记回调
 * （最外层事务提交后执行，回滚时丢弃）并返回 true；不在事务中时返回 false
 */
export type AfterCommitHandler = (callback: () => Promise<void>) => boolean

const kHandlers = Symbol.for('hazejs.after-commit')

/** 挂在 globalThis 上：注册方（@hazejs/orm）与 core 即使是不同的模块实例也共用一份 */
function handlers(): Set<AfterCommitHandler> {
  const scope = globalThis as { [kHandlers]?: Set<AfterCommitHandler> }
  return scope[kHandlers] ??= new Set()
}

/**
 * 注册“事务提交后执行”的实现，返回取消注册的函数。core 不依赖数据库包：
 * `afterCommit()`、任务的 `afterCommit` 与事件的 `afterCommit` 都通过它判断是否处于事务中
 */
export function registerAfterCommitHandler(handler: AfterCommitHandler): () => void {
  handlers().add(handler)
  return () => handlers().delete(handler)
}

function logError(error: unknown, logger: Logger | undefined): void {
  const target = logger ?? getContextApp()?.logger
  if (target)
    target.error('afterCommit callback failed', error)
  else
    console.error('afterCommit callback failed', error)
}

/**
 * 处于数据库事务中时，推迟到最外层事务提交后执行（回滚时丢弃）；不在事务中时立即执行。
 * 推迟执行的回调在提交之后、`Db.transaction()` / `Db.commit()` 返回之前依次执行，抛出的错误只记录日志
 * （事务已经提交，不会再让调用方失败）；立即执行时错误照常抛出。
 *
 * ```ts
 * await Db.transaction(async () => {
 *   await Order.create(...)
 *   await afterCommit(() => OrderPlaced.emit({ id }))
 * })
 * ```
 */
export async function afterCommit(callback: () => MaybePromise<unknown>): Promise<void> {
  if (deferUntilCommit(callback, getContextApp()?.logger))
    return
  await callback()
}

/**
 * 处于事务中时登记回调并返回 true（提交后执行，错误记录到 logger）；否则返回 false，由调用方立即执行。
 * 没有注册实现（未使用数据库包）时总是返回 false
 */
export function deferUntilCommit(callback: () => MaybePromise<unknown>, logger?: Logger): boolean {
  const run = async (): Promise<void> => {
    try {
      await callback()
    }
    catch (error) {
      logError(error, logger)
    }
  }
  for (const handler of handlers()) {
    if (handler(run))
      return true
  }
  return false
}
