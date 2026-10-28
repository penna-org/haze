import type { Application } from '@hazejs/core'
import type { SearchIndex, SearchQuery } from '../src'
import process from 'node:process'
import { Model } from '@hazejs/orm'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { ElasticsearchEngine, flushSearchable, importSearchable, MeilisearchEngine, search, searchable, SearchEngineError, syncSearchSettings, TypesenseEngine, useSearchManager } from '../src'
import { boot, sample, shutdown, sqlitePosts } from './setup'

interface Recorded {
  method: string
  url: URL
  headers: Record<string, string>
  body: string | undefined
}

/** 记录请求的 fetch：按顺序返回预设的响应 */
function mockFetch(responses: Array<{ status?: number, body?: unknown, text?: string }>) {
  const requests: Recorded[] = []
  const fetch = async (input: string, init: RequestInit = {}): Promise<Response> => {
    requests.push({
      method: init.method ?? 'GET',
      url: new URL(input),
      headers: Object.fromEntries(new Headers(init.headers).entries()),
      body: init.body as string | undefined,
    })
    const next = responses.shift() ?? { body: {} }
    return next.text !== undefined
      ? new Response(next.text, {
          status: next.status ?? 200,
          headers: { 'content-type': 'text/plain' },
        })
      : new Response(JSON.stringify(next.body ?? {}), {
          status: next.status ?? 200,
          headers: { 'content-type': 'application/json' },
        })
  }
  return { fetch, requests }
}

const index: SearchIndex = {
  name: 'posts',
  key: 'id',
  settings: {
    searchable: ['title', 'body'],
    filterable: ['status'],
    sortable: ['views'],
  },
}

function query(overrides: Partial<SearchQuery> = {}): SearchQuery {
  return {
    query: 'haze search',
    filters: [
      { type: 'eq', field: 'status', value: 'published' },
      {
        type: 'in',
        field: 'views',
        values: [1, 2],
      },
      {
        type: 'notIn',
        field: 'author',
        values: ['a "quoted" name'],
      },
    ],
    sort: [
      { field: 'views', direction: 'desc' },
    ],
    page: 2,
    perPage: 10,
    withTotal: true,
    options: {},
    ...overrides,
  }
}

describe('meilisearch request shapes', () => {
  it('writes documents, searches and syncs settings', async () => {
    const { fetch, requests } = mockFetch([
      {
        status: 202,
        body: { taskUid: 7 },
      },
      {
        body: { status: 'succeeded' },
      },
      {
        body: {
          hits: [
            { id: 3, title: 'x', _rankingScore: 0.9 },
          ],
          totalHits: 21,
          page: 2,
          hitsPerPage: 10,
        },
      },
      {
        status: 202,
        body: { taskUid: 8 },
      },
      {
        body: {
          status: 'failed',
          error: { code: 'index_already_exists', message: 'exists' },
        },
      },
      {
        status: 202,
        body: { taskUid: 9 },
      },
      {
        body: { status: 'succeeded' },
      },
      {
        status: 404,
        body: { code: 'index_not_found' },
      },
    ])
    const engine = new MeilisearchEngine({
      url: 'http://meili.test/',
      key: 'secret',
      wait: true,
      fetch,
    })

    await engine.update(index, [
      {
        key: 3,
        data: { title: 'x' },
      },
    ])
    expect(requests[0]).toMatchObject({
      method: 'POST',
      headers: { 'authorization': 'Bearer secret', 'content-type': 'application/json' },
    })
    expect(requests[0]!.url.pathname).toBe('/indexes/posts/documents')
    expect(requests[0]!.url.searchParams.get('primaryKey')).toBe('id')
    expect(JSON.parse(requests[0]!.body!)).toEqual([
      { title: 'x', id: 3 },
    ])
    expect(requests[1]!.url.pathname).toBe('/tasks/7')

    const result = await engine.search(index, query())
    expect(JSON.parse(requests[2]!.body!)).toEqual({
      q: 'haze search',
      filter: ['status = "published"', 'views IN [1, 2]', 'author NOT IN ["a \\"quoted\\" name"]'],
      sort: ['views:desc'],
      page: 2,
      hitsPerPage: 10,
      showRankingScore: true,
    })
    expect(result).toMatchObject({
      total: 21,
      hits: [
        { key: 3, score: 0.9 },
      ],
    })

    await engine.syncSettings(index)
    expect(JSON.parse(requests[3]!.body!)).toEqual({ uid: 'posts', primaryKey: 'id' })
    expect(requests[5]).toMatchObject({ method: 'PATCH' })
    expect(JSON.parse(requests[5]!.body!)).toEqual({
      searchableAttributes: ['title', 'body'],
      filterableAttributes: ['status'],
      sortableAttributes: ['views'],
    })

    // 索引不存在时返回空结果
    expect(await engine.search(index, query({ withTotal: false }))).toMatchObject({ hits: [], total: 0 })
    expect(JSON.parse(requests[7]!.body!)).toMatchObject({ offset: 10, limit: 10 })
  })

  it('reports failed tasks and http errors', async () => {
    const failing = mockFetch([
      {
        status: 202,
        body: { taskUid: 1 },
      },
      {
        body: {
          status: 'failed',
          error: { code: 'invalid_document_id', message: 'bad id' },
        },
      },
    ])
    await expect(new MeilisearchEngine({ url: 'http://meili.test', wait: true, fetch: failing.fetch }).update(index, [
      { key: 'a b', data: {} },
    ])).rejects.toThrow(/bad id/)
    const denied = mockFetch([
      {
        status: 403,
        body: { message: 'The provided API key is invalid.' },
      },
    ])
    const error = await new MeilisearchEngine({ url: 'http://meili.test', fetch: denied.fetch }).delete(index, [1]).catch(error => error)
    expect(error).toBeInstanceOf(SearchEngineError)
    expect(error).toMatchObject({
      status: 403,
      message: expect.stringContaining('API key is invalid'),
    })
  })
})

describe('typesense request shapes', () => {
  it('creates the collection on first import, searches and deletes', async () => {
    const { fetch, requests } = mockFetch([
      {
        status: 404,
        body: { message: 'Not found.' },
      },
      {
        status: 201,
        body: { name: 'posts' },
      },
      { text: '{"success":true}\n{"success":true}' },
      {
        body: {
          found: 2,
          hits: [
            {
              document: { id: '5', title: 'x' },
              text_match: 100,
            },
          ],
        },
      },
      {
        body: { num_deleted: 2 },
      },
      { text: '{"success":false,"error":"Bad JSON."}' },
    ])
    const engine = new TypesenseEngine({ url: 'http://typesense.test', key: 'xyz', fetch })

    await engine.update(index, [
      {
        key: 5,
        data: { title: 'x' },
      },
      {
        key: 6,
        data: { title: 'y' },
      },
    ])
    expect(requests[0]!.url.pathname).toBe('/collections/posts/documents/import')
    expect(requests[0]!.url.searchParams.get('action')).toBe('upsert')
    expect(requests[0]!.headers['x-typesense-api-key']).toBe('xyz')
    expect(requests[0]!.body!.split('\n').map(line => JSON.parse(line))).toEqual([
      { title: 'x', id: '5' },
      { title: 'y', id: '6' },
    ])
    expect(JSON.parse(requests[1]!.body!)).toEqual({
      name: 'posts',
      fields: [
        { name: '.*', type: 'auto' },
      ],
    })
    expect(requests[2]!.url.pathname).toBe('/collections/posts/documents/import')

    const result = await engine.search(index, query())
    expect(Object.fromEntries(requests[3]!.url.searchParams)).toEqual({
      q: 'haze search',
      query_by: 'title,body',
      filter_by: 'status:=`published` && views:=[1,2] && author:!=[`a "quoted" name`]',
      sort_by: 'views:desc',
      page: '2',
      per_page: '10',
    })
    expect(result).toMatchObject({
      total: 2,
      hits: [
        { key: '5', score: 100 },
      ],
    })

    await engine.delete(index, [5, 6])
    expect(requests[4]).toMatchObject({ method: 'DELETE' })
    expect(requests[4]!.url.searchParams.get('filter_by')).toBe('id:[`5`,`6`]')

    await expect(engine.update(index, [
      { key: 1, data: {} },
    ])).rejects.toThrow(/Bad JSON/)
  })
})

describe('elasticsearch request shapes', () => {
  it('uses the bulk api, bool queries and basic auth', async () => {
    const { fetch, requests } = mockFetch([
      {
        body: { errors: false, items: [] },
      },
      {
        body: {
          hits: {
            total: { value: 12 },
            hits: [
              {
                _id: '4',
                _score: 1.5,
                _source: { id: 4, title: 'x' },
              },
            ],
          },
        },
      },
      {
        body: {
          errors: true,
          items: [
            {
              delete: { status: 404 },
            },
            {
              delete: {
                status: 500,
                error: { reason: 'shard failure' },
              },
            },
          ],
        },
      },
    ])
    const engine = new ElasticsearchEngine({
      url: 'http://es.test',
      auth: { username: 'elastic', password: 'pw' },
      refresh: true,
      fetch,
    })

    await engine.update(index, [
      {
        key: 4,
        data: { title: 'x' },
      },
    ])
    expect(requests[0]!.url.pathname).toBe('/_bulk')
    expect(requests[0]!.url.searchParams.get('refresh')).toBe('true')
    expect(requests[0]!.headers).toMatchObject({ 'authorization': `Basic ${btoa('elastic:pw')}`, 'content-type': 'application/x-ndjson' })
    expect(requests[0]!.body).toBe('{"index":{"_index":"posts","_id":"4"}}\n{"title":"x","id":4}\n')

    const result = await engine.search(index, query())
    expect(requests[1]!.url.pathname).toBe('/posts/_search')
    expect(JSON.parse(requests[1]!.body!)).toEqual({
      query: {
        bool: {
          must: {
            multi_match: {
              query: 'haze search',
              fields: ['title', 'body'],
              operator: 'and',
              lenient: true,
            },
          },
          filter: [
            {
              term: { 'status.keyword': 'published' },
            },
            {
              terms: {
                views: [1, 2],
              },
            },
            {
              bool: {
                must_not: {
                  terms: {
                    'author.keyword': ['a "quoted" name'],
                  },
                },
              },
            },
          ],
        },
      },
      sort: [
        {
          views: { order: 'desc', unmapped_type: 'keyword' },
        },
      ],
      from: 10,
      size: 10,
      track_total_hits: true,
    })
    expect(result).toMatchObject({
      total: 12,
      hits: [
        { key: 4, score: 1.5 },
      ],
    })

    await expect(engine.delete(index, [1, 2])).rejects.toThrow(/shard failure/)
  })

  it('sends api keys', async () => {
    const { fetch, requests } = mockFetch([
      {
        body: {
          hits: { total: 0, hits: [] },
        },
      },
    ])
    await new ElasticsearchEngine({
      url: 'http://es.test',
      auth: { apiKey: 'abc' },
      fetch,
    }, 'opensearch').search(index, query({ query: '', filters: [], sort: [] }))
    expect(requests[0]!.headers.authorization).toBe('ApiKey abc')
    expect(JSON.parse(requests[0]!.body!).query.bool.must).toEqual({ match_all: {} })
  })
})

// ---------------------------------------------------------------- 真实服务

interface Service {
  name: string
  config: Record<string, unknown>
}

const services: Service[] = [
  // HAZE_TEST_MEILISEARCH_URL=http://127.0.0.1:7700（可选 HAZE_TEST_MEILISEARCH_KEY）
  ...(process.env.HAZE_TEST_MEILISEARCH_URL
    ? [
        {
          name: 'meilisearch',
          config: { url: process.env.HAZE_TEST_MEILISEARCH_URL, key: process.env.HAZE_TEST_MEILISEARCH_KEY, wait: true },
        },
      ]
    : []),
  // HAZE_TEST_TYPESENSE_URL=http://127.0.0.1:8108 与 HAZE_TEST_TYPESENSE_KEY
  ...(process.env.HAZE_TEST_TYPESENSE_URL
    ? [
        {
          name: 'typesense',
          config: { url: process.env.HAZE_TEST_TYPESENSE_URL, key: process.env.HAZE_TEST_TYPESENSE_KEY ?? 'xyz' },
        },
      ]
    : []),
  // HAZE_TEST_ELASTICSEARCH_URL=http://127.0.0.1:9200（可选 HAZE_TEST_ELASTICSEARCH_DRIVER=opensearch）
  ...(process.env.HAZE_TEST_ELASTICSEARCH_URL
    ? [
        {
          name: 'elasticsearch',
          config: { driver: process.env.HAZE_TEST_ELASTICSEARCH_DRIVER ?? 'elasticsearch', url: process.env.HAZE_TEST_ELASTICSEARCH_URL, refresh: true },
        },
      ]
    : []),
]

describe.runIf(services.length).each(services)('$name (real service)', (service) => {
  class Post extends Model.define(sqlitePosts) {
    static override softDelete = true
  }
  searchable(Post, {
    engine: service.name,
    index: `haze_test_posts_${process.pid}`,
    toSearchable: post => ({
      title: post.title,
      body: post.body,
      status: post.status,
      views: post.views,
    }),
    settings: {
      searchable: ['title', 'body'],
      filterable: ['status', 'views'],
      sortable: ['views'],
    },
  })

  let app: Application | undefined
  beforeAll(async () => {
    app = await boot({
      search: {
        default: service.name,
        engines: { [service.name]: service.config },
      },
    })
  })
  afterEach(async () => {
    await flushSearchable(Post)
  })
  afterAll(async () => {
    const manager = useSearchManager()
    const engine = manager.engine(service.name)
    await engine.deleteIndex?.({ name: `haze_test_posts_${process.pid}`, key: 'id', settings: {} })
    await shutdown(app)
  })

  it('indexes, searches, filters, sorts, paginates and removes documents', async () => {
    await syncSearchSettings(Post)
    const posts: Post[] = []
    for (const data of sample)
      posts.push(await Post.create(data))
    await useSearchManager().engine(service.name).settle?.()

    const titles = async (builder: ReturnType<typeof search<typeof Post>>): Promise<string[]> => (await builder.get()).map(post => post.title).sort()
    expect(await titles(search(Post, 'search'))).toEqual(['Full-text search', 'Search engines compared'])
    expect(await titles(search(Post, 'search').where('status', 'published').where('views', 30))).toEqual(['Search engines compared'])
    expect(await titles(search(Post, '').whereIn('status', ['draft']))).toEqual(['Queues and jobs'])
    expect(await titles(search(Post, '').whereNotIn('status', ['draft']))).toHaveLength(3)
    expect(await search(Post, '').orderBy('views', 'desc').keys()).toEqual([
      posts[1]!.id,
      posts[3]!.id,
      posts[0]!.id,
      posts[2]!.id,
    ])

    const page = await search(Post, '').orderBy('views').paginate(2, 3)
    expect(page).toMatchObject({
      total: 4,
      page: 2,
      perPage: 3,
      lastPage: 2,
    })
    expect(page.data.map(post => post.id)).toEqual([posts[1]!.id])

    await posts[1]!.delete()
    await useSearchManager().engine(service.name).settle?.()
    expect(await titles(search(Post, 'search'))).toEqual(['Search engines compared'])
    expect(await search(Post, 'search').raw()).toBeTruthy()

    await flushSearchable(Post)
    expect(await search(Post, '').count()).toBe(0)
    expect(await importSearchable(Post)).toBe(3)
    expect(await search(Post, '').count()).toBe(3)
  })
})
