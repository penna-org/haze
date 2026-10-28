import type { Config } from '@hazejs/core'
import type { EngineConfig, SearchConfig } from './config'
import type { SearchEngine } from './engine'
import { useApp } from '@hazejs/core'
import { defaultSearchConfig } from './config'
import { databaseEngine } from './engines/database'
import { elasticsearchEngine, opensearchEngine } from './engines/elasticsearch'
import { meilisearchEngine } from './engines/meilisearch'
import { MemoryEngine } from './engines/memory'
import { typesenseEngine } from './engines/typesense'

function createEngine(name: string, config: EngineConfig): SearchEngine {
  const driver = config.driver ?? name
  switch (driver) {
    case 'database':
      return databaseEngine(config as never)
    case 'memory':
      return new MemoryEngine()
    case 'meilisearch':
      return meilisearchEngine(config as never)
    case 'typesense':
      return typesenseEngine(config as never)
    case 'elasticsearch':
      return elasticsearchEngine(config as never)
    case 'opensearch':
      return opensearchEngine(config as never)
    case 'custom':
      return (config as { engine: SearchEngine }).engine
    default:
      throw new Error(`Search engine "${name}": unknown driver "${driver}" (set driver in config/search.ts)`)
  }
}

/** 搜索引擎管理（每个应用一个，`inject(SearchManager)` 或 `useSearchManager()`） */
export class SearchManager {
  readonly #engines = new Map<string, SearchEngine>()
  #fake: MemoryEngine | undefined

  constructor(readonly appConfig: Pick<Config, 'get'>) {}

  get config(): Required<Pick<SearchConfig, 'default' | 'engines'>> & SearchConfig {
    const config = this.appConfig.get<SearchConfig | undefined>('search', undefined)
    return {
      ...defaultSearchConfig,
      ...config,
      engines: {
        ...defaultSearchConfig.engines,
        ...config?.engines,
      },
    }
  }

  get defaultEngine(): string {
    return this.config.default
  }

  /** 是否处于 Search.fake() 状态（所有引擎替换为同一个内存引擎，同步不走队列） */
  get faked(): boolean {
    return this.#fake !== undefined
  }

  /** 取引擎（默认 default） */
  engine(name: string = this.config.default): SearchEngine {
    if (this.#fake)
      return this.#fake
    let engine = this.#engines.get(name)
    if (!engine) {
      const config = this.config.engines[name]
      if (!config)
        throw new Error(`Search engine "${name}" is not defined in config/search.ts`)
      engine = createEngine(name, config)
      this.#engines.set(name, engine)
    }
    return engine
  }

  /** 测试：所有引擎替换为内存引擎，返回它（可读取已写入的文档） */
  fake(): MemoryEngine {
    this.#fake = new MemoryEngine()
    return this.#fake
  }

  restore(): void {
    this.#fake = undefined
  }
}

const managers = new WeakMap<object, SearchManager>()

/** 应用的搜索管理器（按应用缓存） */
export function searchManagerOf(app: { config: Pick<Config, 'get'> }): SearchManager {
  let manager = managers.get(app)
  if (!manager) {
    manager = new SearchManager(app.config)
    managers.set(app, manager)
  }
  return manager
}

/** 当前应用的搜索管理器：请求内取请求所属应用，否则取最近启动的应用 */
export function useSearchManager(): SearchManager {
  return searchManagerOf(useApp())
}
