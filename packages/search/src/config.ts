import type { ConfigInput } from '@hazejs/core'
import type { SearchEngine } from './engine'
import type { DatabaseEngineConfig } from './engines/database'
import type { ElasticsearchConfig } from './engines/elasticsearch'
import type { MeilisearchConfig } from './engines/meilisearch'
import type { TypesenseConfig } from './engines/typesense'

export type EngineConfig
  = | ({ driver?: 'database' } & DatabaseEngineConfig)
    | { driver?: 'memory' }
    | ({ driver?: 'meilisearch' } & MeilisearchConfig)
    | ({ driver?: 'typesense' } & TypesenseConfig)
    | ({ driver?: 'elasticsearch' | 'opensearch' } & ElasticsearchConfig)
    | { driver: 'custom', engine: SearchEngine }

export interface SearchQueueConfig {
  /** 队列连接，默认 config/queue.ts 的 default */
  connection?: string
  queue?: string
}

export interface SearchConfig {
  /** 默认引擎名（engines 的键），默认 `database` */
  default?: string
  /**
   * 引擎：键为引擎名，`driver` 缺省时取键名（database / memory / meilisearch / typesense / elasticsearch / opensearch）
   */
  engines?: Record<string, EngineConfig>
  /** 索引名前缀（多个环境共用一个搜索服务时区分），默认无 */
  prefix?: string
  /** 模型变更后通过队列同步索引（任务 `search:sync`），默认 false；模型的 queue 选项优先 */
  queue?: boolean | SearchQueueConfig
  /** `search:import` 每批读取的数量，默认 500 */
  chunk?: number
}

export const defaultSearchConfig = {
  default: 'database',
  engines: {
    database: {},
  },
} satisfies SearchConfig

/** `config/search.ts` 的默认导出 */
export function defineSearchConfig(config: ConfigInput<SearchConfig>): ConfigInput<SearchConfig> {
  return config
}
