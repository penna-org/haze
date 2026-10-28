import type { Application } from '@hazejs/core'
import type { ConnectionConfig } from '@hazejs/orm'
import type { DatabaseSearchOptions } from '../src'
import process from 'node:process'
import { Tenancy } from '@hazejs/core'
import { Db, Model } from '@hazejs/orm'
import { sql } from 'drizzle-orm'
import { afterEach, describe, expect, it } from 'vitest'
import { createSearchIndex, dropSearchIndexSql, importSearchable, search, searchable, searchIndexSql, syncSearchSettings } from '../src'
import { boot, ddl, mysqlPosts, pgPosts, sample, shutdown, sqlitePosts } from './setup'

interface Case {
  name: string
  connection: ConnectionConfig
  table: typeof sqlitePosts
  ddl: string[]
  database?: DatabaseSearchOptions
}

const cases: Case[] = [
  {
    name: 'sqlite fts5 (triggers)',
    connection: { driver: 'sqlite', url: ':memory:' },
    table: sqlitePosts,
    ddl: ddl.sqlite,
  },
  {
    name: 'sqlite fts5 (engine sync)',
    connection: { driver: 'sqlite', url: ':memory:' },
    table: sqlitePosts,
    ddl: ddl.sqlite,
    database: {
      fts: { sync: 'engine' },
    },
  },
  {
    name: 'sqlite like',
    connection: { driver: 'sqlite', url: ':memory:' },
    table: sqlitePosts,
    ddl: ddl.sqlite,
    database: { mode: 'like' },
  },
  {
    name: 'postgres (pglite)',
    connection: { driver: 'pglite' },
    table: pgPosts as unknown as typeof sqlitePosts,
    ddl: ddl.postgres,
  },
  {
    name: 'postgres like (pglite)',
    connection: { driver: 'pglite' },
    table: pgPosts as unknown as typeof sqlitePosts,
    ddl: ddl.postgres,
    database: { mode: 'like' },
  },
  // 真实服务：HAZE_TEST_PG_URL=postgres://user:pass@127.0.0.1:5432/test
  ...(process.env.HAZE_TEST_PG_URL
    ? [
        {
          name: 'postgres',
          connection: { driver: 'postgres' as const, url: process.env.HAZE_TEST_PG_URL },
          table: pgPosts as unknown as typeof sqlitePosts,
          ddl: ddl.postgres,
        },
      ]
    : []),
  // HAZE_TEST_MYSQL_URL=mysql://root:pass@127.0.0.1:3306/test
  ...(process.env.HAZE_TEST_MYSQL_URL
    ? [
        {
          name: 'mysql fulltext',
          connection: { driver: 'mysql' as const, url: process.env.HAZE_TEST_MYSQL_URL },
          table: mysqlPosts as unknown as typeof sqlitePosts,
          ddl: ddl.mysql,
        },
        {
          name: 'mysql fulltext (boolean)',
          connection: { driver: 'mysql' as const, url: process.env.HAZE_TEST_MYSQL_URL },
          table: mysqlPosts as unknown as typeof sqlitePosts,
          ddl: ddl.mysql,
          database: { mysqlMode: 'boolean' as const },
        },
        {
          name: 'mysql like',
          connection: { driver: 'mysql' as const, url: process.env.HAZE_TEST_MYSQL_URL },
          table: mysqlPosts as unknown as typeof sqlitePosts,
          ddl: ddl.mysql,
          database: { mode: 'like' as const },
        },
      ]
    : []),
]

let app: Application | undefined
afterEach(async () => {
  await shutdown(app)
  app = undefined
})

describe.each(cases)('database engine on $name', (testCase) => {
  class Post extends Model.define(testCase.table) {
    static override softDelete = true
    static override belongsToTenant = true
  }
  searchable(Post, {
    settings: {
      searchable: ['title', 'body'],
    },
    database: testCase.database,
  })

  async function setup(): Promise<Post[]> {
    app = await boot({
      connection: testCase.connection,
      ddl: testCase.ddl,
      search: {
        default: 'database',
        engines: { database: {} },
      },
      tenancy: {
        find: (key: string) => ({ id: key }),
      },
    })
    await syncSearchSettings(Post)
    // 再次同步不报错（索引已存在）
    await syncSearchSettings(Post)
    const posts: Post[] = []
    for (const data of sample)
      posts.push(await Post.create(data))
    return posts
  }

  it('finds matching models with filters, sorting and pagination', async () => {
    const posts = await setup()
    const titles = (models: Post[]): string[] => models.map(post => post.title).sort()

    const found = await search(Post, 'search').get()
    expect(found[0]).toBeInstanceOf(Post)
    expect(titles(found)).toEqual(['Full-text search', 'Search engines compared'])
    expect(await search(Post, 'search').keys()).toEqual(found.map(post => post.id))

    // 多个词（MySQL 自然语言模式为任意一个词，其余为全部出现）
    const both = await search(Post, 'redis worker').get()
    expect(titles(both)).toEqual(['Queues and jobs'])

    expect(titles(await search(Post, 'search').where('status', 'published').whereNotIn('id', [posts[1]!.id]).get())).toEqual(['Search engines compared'])
    expect(titles(await search(Post, '').whereIn('status', ['draft']).get())).toEqual(['Queues and jobs'])
    expect((await search(Post, '').orderBy('views', 'desc').keys())).toEqual([
      posts[1]!.id,
      posts[3]!.id,
      posts[0]!.id,
      posts[2]!.id,
    ])

    const page = await search(Post, 'search').orderBy('views', 'desc').paginate(1, 1)
    expect(page).toMatchObject({
      total: 2,
      page: 1,
      perPage: 1,
      lastPage: 2,
    })
    expect(page.data.map(post => post.id)).toEqual([posts[1]!.id])
    expect(await search(Post, 'search').count()).toBe(2)

    // 查询约束直接作用于搜索查询
    expect(titles(await search(Post, 'search').constrain(query => query.where('views', '<', 40)).get())).toEqual(['Search engines compared'])
    expect(await search(Post, 'definitely-not-there').get()).toEqual([])
    // 特殊字符不会造成语法错误（MySQL 布尔模式按其语法解析，不在此列）
    if (testCase.database?.mysqlMode !== 'boolean')
      expect(await search(Post, '"unbalanced (quote* -:').get()).toEqual([])
  })

  it('keeps the index in sync on update / delete and respects soft deletes and tenants', async () => {
    const posts = await setup()
    posts[0]!.title = 'Getting started with search'
    await posts[0]!.save()
    expect((await search(Post, 'search').get()).map(post => post.id)).toContain(posts[0]!.id)

    await posts[1]!.delete()
    expect((await search(Post, 'search').get()).map(post => post.id)).not.toContain(posts[1]!.id)
    await posts[1]!.restore()
    await posts[3]!.forceDelete()
    expect((await search(Post, 'search').get()).map(post => post.id).sort()).toEqual([posts[0]!.id, posts[1]!.id].sort())

    // belongsToTenant：租户上下文中只搜索当前租户的数据
    await Tenancy.run('acme', () => Post.create({ title: 'Acme search notes', body: '' }))
    expect((await Tenancy.run('acme', () => search(Post, 'search').get())).map(post => post.title)).toEqual(['Acme search notes'])
    expect(await search(Post, 'search').count()).toBe(3)

    // import 重建（triggers 模式 rebuild，engine 模式逐条写入）
    expect(await importSearchable(Post)).toBe(4)
    expect(await search(Post, 'search').count()).toBe(3)
  })

  it('generates the index DDL', async () => {
    await setup()
    const statements = searchIndexSql(Post)
    const drop = dropSearchIndexSql(Post)
    if (testCase.database?.mode === 'like') {
      expect(statements).toEqual([])
      return
    }
    expect(statements.length).toBeGreaterThan(0)
    expect(drop.length).toBeGreaterThan(0)
    // 删除后重新创建
    for (const statement of drop)
      await Db.execute(sql.raw(statement))
    await createSearchIndex(Post)
    await importSearchable(Post)
    expect(await search(Post, 'search').count()).toBe(2)
  })
})

describe('database engine DDL', () => {
  class Article extends Model.define(sqlitePosts) {}
  searchable(Article, {
    index: 'articles',
    settings: {
      searchable: ['title', 'body'],
    },
    database: {
      language: 'simple',
      fts: { tokenize: 'trigram' },
    },
  })

  it('renders the statements for each dialect', async () => {
    app = await boot({
      search: {
        default: 'database',
        engines: { database: {} },
      },
    })
    expect(searchIndexSql(Article, 'mysql')).toEqual(['alter table `posts` add fulltext index `posts_search` (`title`, `body`)'])
    expect(searchIndexSql(Article, 'postgres')).toEqual([`create index if not exists "posts_search" on "posts" using gin (to_tsvector('simple'::regconfig, coalesce("title", '') || ' ' || coalesce("body", '')))`])
    const sqlite = searchIndexSql(Article, 'sqlite')
    expect(sqlite[0]).toBe(`create virtual table if not exists "posts_fts" using fts5("title", "body", content='posts', content_rowid='id', tokenize='trigram')`)
    expect(sqlite).toHaveLength(5)
    // trigram 分词器：子串匹配（中文等无空格的语言）
    await createSearchIndex(Article)
    await Article.create({ title: '全文搜索引擎', body: '数据库内置的搜索' })
    expect((await search(Article, '搜索引擎').get()).map(article => article.title)).toEqual(['全文搜索引擎'])
  })
})
