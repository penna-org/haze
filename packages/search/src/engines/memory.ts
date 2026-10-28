import type { DocumentKey, SearchDocument, SearchEngine, SearchFilter, SearchIndex, SearchQuery, SearchResult } from '../engine'
import { tokenize } from '../engine'

/** 比较时统一为字符串（数字主键与字符串主键视为相同） */
const same = (a: unknown, b: unknown): boolean => a === b || (a !== null && b !== null && a !== undefined && b !== undefined && String(a) === String(b))

function matches(document: Record<string, unknown>, filter: SearchFilter): boolean {
  const value = document[filter.field]
  const values = Array.isArray(value)
    ? value
    : [value]
  switch (filter.type) {
    case 'eq':
      return values.some(item => same(item, filter.value))
    case 'in':
      return values.some(item => filter.values.some(expected => same(item, expected)))
    case 'notIn':
      return !values.some(item => filter.values.some(expected => same(item, expected)))
  }
}

function compare(a: unknown, b: unknown): number {
  if (a === b)
    return 0
  if (a === undefined || a === null)
    return -1
  if (b === undefined || b === null)
    return 1
  if (typeof a === 'number' && typeof b === 'number')
    return a - b
  return String(a).localeCompare(String(b))
}

/** 字段文本（数组展开、对象忽略） */
function textOf(value: unknown): string {
  if (Array.isArray(value))
    return value.map(textOf).join(' ')
  return typeof value === 'string' || typeof value === 'number'
    ? String(value).toLowerCase()
    : ''
}

/**
 * 内存引擎：测试与原型使用（进程内，不持久化）。
 * 每个搜索词都要出现在某个可搜索字段中（子串匹配，大小写不敏感），按出现次数计算相关度。
 */
export class MemoryEngine implements SearchEngine {
  readonly driver = 'memory'
  readonly #indexes = new Map<string, Map<string, Record<string, unknown>>>()

  /** 索引中的全部文档（按写入顺序） */
  documents(index: string): Array<Record<string, unknown>> {
    return [
      ...this.#indexes.get(index)?.values() ?? [],
    ]
  }

  /** 已存在的索引名 */
  indexes(): string[] {
    return [
      ...this.#indexes.keys(),
    ]
  }

  async update(index: SearchIndex, documents: SearchDocument[]): Promise<void> {
    const store = this.#index(index.name)
    for (const document of documents) {
      store.set(String(document.key), structuredClone({
        ...document.data,
        [index.key]: document.key,
      }))
    }
  }

  async delete(index: SearchIndex, keys: DocumentKey[]): Promise<void> {
    const store = this.#indexes.get(index.name)
    for (const key of keys)
      store?.delete(String(key))
  }

  async flush(index: SearchIndex): Promise<void> {
    this.#indexes.get(index.name)?.clear()
  }

  async syncSettings(index: SearchIndex): Promise<void> {
    this.#index(index.name)
  }

  async deleteIndex(index: SearchIndex): Promise<void> {
    this.#indexes.delete(index.name)
  }

  async search(index: SearchIndex, query: SearchQuery): Promise<SearchResult> {
    const terms = tokenize(query.query)
    const searchable = index.settings.searchable
    const scored: Array<{ document: Record<string, unknown>, score: number, order: number }> = []
    let order = 0
    for (const document of this.#indexes.get(index.name)?.values() ?? []) {
      order++
      if (!query.filters.every(filter => matches(document, filter)))
        continue
      const fields = (searchable ?? Object.keys(document)).map(field => textOf(document[field]))
      let score = 0
      let matchedAll = true
      for (const term of terms) {
        let count = 0
        for (const text of fields)
          count += text.split(term).length - 1
        if (!count) {
          matchedAll = false
          break
        }
        score += count
      }
      if (matchedAll)
        scored.push({ document, score, order })
    }
    scored.sort((a, b) => {
      for (const { field, direction } of query.sort) {
        const result = compare(a.document[field], b.document[field])
        if (result) {
          return direction === 'desc'
            ? -result
            : result
        }
      }
      return query.sort.length
        ? a.order - b.order
        : b.score - a.score || a.order - b.order
    })
    const start = (query.page - 1) * query.perPage
    const page = scored.slice(start, start + query.perPage)
    return {
      hits: page.map(({ document, score }) => ({
        key: document[index.key] as DocumentKey,
        score,
        document: structuredClone(document),
      })),
      total: scored.length,
      raw: page.map(({ document }) => document),
    }
  }

  #index(name: string): Map<string, Record<string, unknown>> {
    let index = this.#indexes.get(name)
    if (!index)
      this.#indexes.set(name, index = new Map())
    return index
  }
}

export function memoryEngine(): MemoryEngine {
  return new MemoryEngine()
}
