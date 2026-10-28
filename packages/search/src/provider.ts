import type { ServiceProvider } from '@hazejs/core'
import type { MemoryEngine } from './engines/memory'
import { QueueManager } from '@hazejs/core'
import { SearchManager, searchManagerOf, useSearchManager } from './manager'
import { searchSyncJob, withoutSyncing } from './searchable'

/**
 * 搜索服务提供者（app/provider/SearchProvider.ts）：
 *
 * ```ts
 * import { searchProvider } from '@hazejs/search'
 *
 * export default searchProvider()
 * ```
 *
 * 注册 SearchManager（可 inject）与队列同步任务 `search:sync`（queue 开启时 worker 进程需要它）。
 */
export function searchProvider(): ServiceProvider {
  return {
    register(container, app) {
      container.instance(SearchManager, searchManagerOf(app))
      container.make(QueueManager).register(searchSyncJob)
    },
  }
}

/**
 * 搜索门面：
 *
 * ```ts
 * const engine = Search.fake() // 测试：所有引擎换成内存引擎
 * await Post.create({ title: 'Hello' })
 * expect(engine.documents('posts')).toHaveLength(1)
 * ```
 */
export const Search = {
  manager: (): SearchManager => useSearchManager(),
  engine: (name?: string) => useSearchManager().engine(name),
  /** 所有引擎替换为同一个内存引擎（同步不走队列），返回它 */
  fake: (): MemoryEngine => useSearchManager().fake(),
  restore: (): void => useSearchManager().restore(),
  withoutSyncing,
}
