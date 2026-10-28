import type { Application } from '@hazejs/core'
import type { MemoryEngine } from '../src'
import { Queue, Tenancy } from '@hazejs/core'
import { Model } from '@hazejs/orm'
import { afterEach, describe, expect, it } from 'vitest'
import { flushSearchable, importSearchable, search, Search, searchable, syncSearchSettings, useSearchManager, withoutSyncing } from '../src'
import { boot, sample, shutdown, sqlitePosts } from './setup'

class Post extends Model.define(sqlitePosts) {
  static override softDelete = true
}
const SearchablePost = searchable(Post, {
  toSearchable: post => ({
    title: post.title,
    body: post.body,
    status: post.status,
    views: post.views,
  }),
  shouldBeSearchable: post => post.status !== 'archived',
  settings: {
    searchable: ['title', 'body'],
    filterable: ['status'],
    sortable: ['views'],
  },
})

class TenantPost extends Model.define(sqlitePosts) {
  static override belongsToTenant = true
}
searchable(TenantPost, { index: 'tenant_posts' })

let app: Application | undefined
afterEach(async () => {
  await shutdown(app)
  app = undefined
})

function memory(): MemoryEngine {
  return useSearchManager().engine() as MemoryEngine
}

async function seed(): Promise<Post[]> {
  const posts: Post[] = []
  for (const data of sample)
    posts.push(await Post.create(data))
  return posts
}

describe('memory engine and index syncing', () => {
  it('indexes models on create / update / delete / restore', async () => {
    app = await boot()
    const [first] = await seed()
    expect(memory().documents('posts')).toHaveLength(4)
    expect(memory().documents('posts')[0]).toEqual({
      id: first!.id,
      title: 'Getting started with haze',
      body: 'Install the framework and create your first route',
      status: 'published',
      views: 10,
    })

    first!.title = 'Getting started with hazejs'
    await first!.save()
    expect(memory().documents('posts')[0]!.title).toBe('Getting started with hazejs')

    // 软删除从索引中移除，恢复后重新加入
    await first!.delete()
    expect(memory().documents('posts').map(doc => doc.id)).not.toContain(first!.id)
    await first!.restore()
    expect(memory().documents('posts').map(doc => doc.id)).toContain(first!.id)
    await first!.forceDelete()
    expect(memory().documents('posts')).toHaveLength(3)

    // shouldBeSearchable 为 false 时移出索引
    const [second] = await Post.order('id').select()
    await second!.save({ status: 'archived' })
    expect(memory().documents('posts').map(doc => doc.id)).not.toContain(second!.id)
  })

  it('searches with filters, sorting, pagination and returns models in relevance order', async () => {
    app = await boot()
    const posts = await seed()

    const found = await search(Post, 'search').get()
    // “Search engines compared” 中 search 出现 3 次，相关度最高
    expect(found.map(post => post.title)).toEqual(['Search engines compared', 'Full-text search'])
    expect(found[0]).toBeInstanceOf(Post)

    const keys = await SearchablePost.search('meilisearch typesense').keys()
    expect(keys).toHaveLength(2)
    expect(keys).toEqual(expect.arrayContaining([posts[1]!.id, posts[3]!.id]))
    expect((await search(Post, '').where('status', 'draft').get()).map(post => post.title)).toEqual(['Queues and jobs'])
    expect((await search(Post, '').whereIn('status', ['draft']).count())).toBe(1)
    expect((await search(Post, '').whereNotIn('status', ['draft']).count())).toBe(3)
    expect((await search(Post, '').orderBy('views', 'desc').keys())).toEqual([
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

    const raw = await search(Post, 'redis').raw() as Array<Record<string, unknown>>
    expect(raw[0]!.title).toBe('Queues and jobs')
    expect((await search(Post, 'nothing-matches').first())).toBeUndefined()

    // 加载模型时的约束；数据库中已不存在的记录被略过
    expect((await search(Post, 'search').constrain(query => query.where('views', '>', 40)).get()).map(post => post.title)).toEqual(['Full-text search'])
  })

  it('does not sync inside withoutSyncing() and can re-import / flush', async () => {
    app = await boot()
    await withoutSyncing(seed)
    expect(memory().documents('posts')).toHaveLength(0)
    expect(await importSearchable('Post', { chunk: 3 })).toBe(4)
    expect(memory().documents('posts')).toHaveLength(4)
    await flushSearchable(Post)
    expect(memory().documents('posts')).toHaveLength(0)
    expect(await syncSearchSettings()).toEqual(expect.arrayContaining([
      { model: 'Post', index: 'posts', engine: 'memory' },
      { model: 'TenantPost', index: 'tenant_posts', engine: 'memory' },
    ]))
    await expect(importSearchable('Unknown')).rejects.toThrow(/No searchable model named "Unknown"/)
  })

  it('syncs through the queue when configured', async () => {
    app = await boot({
      search: {
        default: 'memory',
        engines: { memory: {} },
        queue: true,
      },
      queue: {
        default: 'memory',
        connections: {
          memory: { driver: 'memory' },
        },
      },
    })
    const fake = Queue.fake()
    await Post.create(sample[0]!)
    fake.assertDispatched('search:sync', (payload: any) => payload.index.name === 'posts' && payload.documents[0].data.title === sample[0]!.title)
    expect(memory().documents('posts')).toHaveLength(0)
    await fake.drain()
    expect(memory().documents('posts')).toHaveLength(1)
    Queue.restore()

    // 真实的内存队列
    const post = await Post.create(sample[1]!)
    await Queue.idle()
    expect(memory().documents('posts')).toHaveLength(2)
    await post.forceDelete()
    await Queue.idle()
    expect(memory().documents('posts')).toHaveLength(1)
  })

  it('fakes every engine with Search.fake()', async () => {
    app = await boot({
      search: {
        default: 'meilisearch',
        engines: {
          meilisearch: { url: 'http://127.0.0.1:1' },
        },
      },
    })
    const fake = Search.fake()
    await Post.create(sample[0]!)
    expect(fake.documents('posts')).toHaveLength(1)
    expect((await search(Post, 'haze').get()).map(post => post.title)).toEqual([sample[0]!.title])
    Search.restore()
    expect(useSearchManager().engine().driver).toBe('meilisearch')
  })

  it('filters by the tenant column inside a tenant context', async () => {
    app = await boot({
      tenancy: {
        find: (key: string) => ({ id: key }),
      },
    })
    await Tenancy.run('acme', () => TenantPost.create({ title: 'Acme search' }))
    await Tenancy.run('globex', () => TenantPost.create({ title: 'Globex search' }))
    expect(memory().documents('tenant_posts').map(doc => doc.tenantId)).toEqual(['acme', 'globex'])
    expect((await Tenancy.run('acme', () => search(TenantPost, 'search').get())).map(post => post.title)).toEqual(['Acme search'])
    expect((await search(TenantPost, 'search').count())).toBe(2)
  })
})
