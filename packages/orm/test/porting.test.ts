import type { Row } from '../src'
import type { TestDialect } from './schemas'
import { createApplication, defineRoutes } from '@hazejs/core'
import { and, count, eq, sql } from 'drizzle-orm'
import { int as myInt, serial as mySerial, mysqlTable, varchar } from 'drizzle-orm/mysql-core'
import { integer as pgInt, pgTable, text as pgText, serial } from 'drizzle-orm/pg-core'
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { afterAll, beforeAll, beforeEach, describe, expect, expectTypeOf, it } from 'vitest'
import { DatabaseError, DatabaseManager, Db, Model, setDatabaseManager, transaction, UniqueConstraintException } from '../src'
import { dialects } from './schemas'

// 迁移真实后端（ai-admin）时发现的问题：where(undefined)、写操作返回行、upsert 表达式、联表可空类型、唯一约束信息等

/** 版本列默认值为 1 的表（乐观锁不应覆盖列的默认值） */
const documents = {
  sqlite: sqliteTable('documents', {
    id: integer('id').primaryKey({ autoIncrement: true }),
    title: text('title').notNull(),
    revision: integer('revision').notNull().default(1),
  }),
  postgres: pgTable('documents', {
    id: serial('id').primaryKey(),
    title: pgText('title').notNull(),
    revision: pgInt('revision').notNull().default(1),
  }),
  mysql: mysqlTable('documents', {
    id: mySerial('id').primaryKey(),
    title: varchar('title', { length: 255 }).notNull(),
    revision: myInt('revision').notNull().default(1),
  }),
}

const documentsDdl = {
  sqlite: 'create table documents (id integer primary key autoincrement, title text not null, revision integer not null default 1)',
  postgres: 'create table documents (id serial primary key, title text not null, revision integer not null default 1)',
  mysql: 'create table documents (id serial primary key, title varchar(255) not null, revision int not null default 1)',
}

function family(dialect: TestDialect): 'sqlite' | 'postgres' | 'mysql' {
  return dialect.name === 'pglite'
    ? 'postgres'
    : dialect.name === 'mysql'
      ? 'mysql'
      : 'sqlite'
}

describe.each(dialects)('porting gaps on $name', (dialect) => {
  const { users, posts, articles } = dialect.schema
  const kind = family(dialect)
  const docs = documents[kind] as typeof documents.sqlite
  const queries: string[] = []
  let manager: DatabaseManager

  class User extends Model.define(users) {
    static override softDelete = true
    static override readonly = ['email']
    static events: string[] = []

    onBeforeUpdate() {
      User.events.push('beforeUpdate')
    }
  }

  class Article extends Model.define(articles) {
    static override optimLock = true
  }

  class Document extends Model.define(docs) {
    static override optimLock = 'revision'
  }

  beforeAll(async () => {
    await dialect.setup?.()
  })

  beforeEach(async () => {
    manager = new DatabaseManager({
      default: 'main',
      connections: {
        main: { ...dialect.connection, logging: true },
      },
    }, {
      logger: {
        debug: (message: string) => queries.push(message.toLowerCase()),
      } as never,
    })
    setDatabaseManager(manager)
    await manager.close()
    for (const statement of [...dialect.ddl, 'drop table if exists documents', documentsDdl[kind]])
      await Db.execute(sql.raw(statement))
    queries.length = 0
    User.events = []
  })

  afterAll(async () => {
    await manager.close()
    await dialect.dispose?.()
  })

  async function seed() {
    await Db.table(users).insert([
      { name: 'Ada', email: 'ada@example.com', age: 36 },
      {
        name: 'Bob',
        email: 'bob@example.com',
        age: 17,
        status: 0,
      },
      { name: 'Cleo', email: null, age: 25 },
    ])
    await Db.table(posts).insert([
      { userId: 1, title: 'Hello', views: 5 },
      { userId: 1, title: 'World', views: 50 },
      { userId: 2, title: 'Bob post', views: 1 },
    ])
  }

  it('ignores where(undefined) from drizzle and() / or() (item 1)', async () => {
    await seed()
    const status: number | undefined = undefined
    expect(await Db.table(users).where(and(status === undefined
      ? undefined
      : eq(users.status, status))).count()).toBe(3)
    expect(await Db.table(users).where(undefined).orWhere(undefined).whereNot(undefined).where('age', '>', 20).count()).toBe(2)
    expect(await User.where(undefined).count()).toBe(3)
    expect(await Db.table(users).where(and(eq(users.status, 1), undefined)).count()).toBe(2)
    // 只有 undefined 条件时不算“有条件”，仍然拒绝无条件更新
    await expect(Db.table(users).where(undefined).update({ status: 2 })).rejects.toThrow(/without conditions/)
  })

  it('whenDefined() only skips undefined / null, when() also skips false and empty strings (item 14)', async () => {
    await seed()
    const filter = (value: boolean | undefined) => Db.table(users).whenDefined(value, (q, enabled) => q.where('status', enabled ? 1 : 0)).count()
    expect(await filter(undefined)).toBe(3)
    expect(await filter(false)).toBe(1)
    expect(await filter(true)).toBe(2)
    expect(await Db.table(users).when(false, q => q.where('status', 0)).count()).toBe(3)
    expect(await Db.table(users).when(0, q => q.where('status', 0)).count()).toBe(1)
  })

  it('marks left / right / full joined columns as nullable and selects whole tables (items 2, 21)', async () => {
    await seed()
    const rows = await Db.table(users)
      .leftJoin(posts, 'users.id', 'posts.userId')
      .field({ name: users.name, title: posts.title, post: posts })
      .order('users.id')
      .order('posts.id')
      .select()
    expectTypeOf(rows).toEqualTypeOf<Array<{ name: string, title: string | null, post: Row<typeof posts> | null }>>()
    expect(rows.map(row => [row.name, row.title, row.post?.views ?? null])).toEqual([
      ['Ada', 'Hello', 5],
      ['Ada', 'World', 50],
      ['Bob', 'Bob post', 1],
      ['Cleo', null, null],
    ])
    expect(rows[0].post).toEqual({
      id: 1,
      userId: 1,
      title: 'Hello',
      views: 5,
    })

    // 内连接不改变可空性；整张表为行对象
    const inner = await Db.table(posts).join(users, 'posts.userId', 'users.id').field({ title: posts.title, author: users }).order('posts.id').find()
    expectTypeOf(inner).toEqualTypeOf<{ title: string, author: Row<typeof users> } | undefined>()
    expect(inner?.author.name).toBe('Ada')

    // 右连接：主表与之前连接的表可空；全连接：全部可空（仅类型）
    const _right = () => Db.table(posts).join(articles, 'posts.id', 'articles.id').rightJoin(users, 'posts.userId', 'users.id').field({ title: posts.title, slug: articles.title, name: users.name })
    expectTypeOf<Awaited<ReturnType<ReturnType<typeof _right>['select']>>>().toEqualTypeOf<Array<{ title: string | null, slug: string | null, name: string }>>()
    const _full = () => Db.table(posts).fullJoin(users, 'posts.userId', 'users.id').field({ title: posts.title, name: users.name })
    expectTypeOf<Awaited<ReturnType<ReturnType<typeof _full>['select']>>>().toEqualTypeOf<Array<{ title: string | null, name: string | null }>>()
    // 模型查询上联表仍是模型查询
    const models = await User.query().leftJoin(posts, 'users.id', 'posts.userId').where('posts.views', '>', 10).with().select()
    expect(models.map(user => user.name)).toEqual(['Ada'])
  })

  it('carries constraint details and a distinct code on UniqueConstraintException (items 3, 25)', async () => {
    await Db.table(articles).insert({ title: 'One', slug: 'one' })
    const error = await Db.table(articles).insert({ title: 'Two', slug: 'one' }).catch(error => error)
    expect(error).toBeInstanceOf(UniqueConstraintException)
    expect(error.status).toBe(409)
    expect(error.code).toBe('unique_violation')
    expect(error.table).toBe('articles')
    expect(error.detail).toBeTypeOf('string')
    if (kind === 'postgres') {
      expect(error.constraint).toBe('articles_slug_key')
      expect(error.columns).toEqual(['slug'])
      expect(error.detail).toContain('already exists')
    }
    else if (kind === 'sqlite') {
      expect(error.columns).toEqual(['slug'])
    }
    else {
      expect(error.constraint).toBe('slug')
    }
  })

  it('update() drops undefined values and can return the updated rows (item 4)', async () => {
    await seed()
    await expect(Db.table(users).where('id', 1).update({ name: undefined })).rejects.toThrow(DatabaseError)
    await expect(Db.table(users).where('id', 1).update({ name: undefined })).rejects.toThrow('update() called without data')
    expect(await Db.table(users).where('id', 1).update({ name: 'Ada L', email: undefined })).toBe(1)
    expect(await Db.table(users).where('id', 1).value('email')).toBe('ada@example.com')
    if (kind === 'mysql') {
      await expect(Db.table(users).where('id', 1).update({ age: 1 }, { returning: true })).rejects.toThrow(/not supported on MySQL/)
      return
    }
    const rows = await Db.table(users).where('age', '>', 20).update({ status: sql`${users.status} + 10` }, { returning: true })
    expectTypeOf(rows).toEqualTypeOf<Array<Row<typeof users>>>()
    expect(rows.map(row => [row.name, row.status]).sort()).toEqual([
      ['Ada L', 11],
      ['Cleo', 11],
    ])
    // 模型查询的 update 同样可返回行（原始行，不是模型）
    const deleted = await User.where('id', 2).update({ age: 18 }, { returning: true })
    expect(deleted[0].age).toBe(18)
  })

  it('upsert() takes expressions, a where condition and returning (item 5)', async () => {
    await Db.table(articles).insert({ title: 'One', slug: 'one' })
    await Db.table(articles).upsert({ title: 'Again', slug: 'one' }, {
      target: 'slug',
      update: { lockVersion: sql`${articles.lockVersion} + 1` },
    })
    expect(await Db.table(articles).where('slug', 'one').find()).toMatchObject({ title: 'One', lockVersion: 1 })
    if (kind === 'mysql') {
      await expect(Db.table(articles).upsert({ title: 'x', slug: 'one' }, { target: 'slug', where: sql`1 = 1` })).rejects.toThrow(/not supported on MySQL/)
      await expect(Db.table(articles).upsert({ title: 'x', slug: 'one' }, { target: 'slug', returning: true })).rejects.toThrow(/not supported on MySQL/)
      return
    }
    // where 不成立：不更新
    const guarded = {
      target: 'slug',
      update: { lockVersion: sql`${articles.lockVersion} + 1` },
      where: sql`${articles.lockVersion} < 1`,
    } as const
    expect(await Db.table(articles).upsert({ title: 'Again', slug: 'one' }, guarded)).toBe(0)
    expect(await Db.table(articles).where('slug', 'one').value('lockVersion')).toBe(1)
    const rows = await Db.table(articles).upsert([
      { title: 'Two', slug: 'two' },
      { title: 'One!', slug: 'one' },
    ], {
      target: 'slug',
      update: ['title'],
      returning: true,
    })
    expectTypeOf(rows).toEqualTypeOf<Array<Row<typeof articles>>>()
    expect(rows.map(row => row.title).sort()).toEqual(['One!', 'Two'])
  })

  it('insert() accepts SQL values and can skip returning rows (item 6)', async () => {
    const [row] = await Db.table(users).insert({ name: sql`upper(${'ada'})`, status: sql`${2} + 1` })
    expect(row).toMatchObject({ name: 'ADA', status: 3 })
    expect(await Db.table(users).insert([
      { name: 'Bob' },
      { name: 'Cleo' },
    ], { returning: false })).toBe(2)
    expect(await Db.table(users).insert([], { returning: false })).toBe(0)
    const user = await User.create({ name: sql`lower(${'DAN'})` })
    expect(user.name).toBe('dan')
    expect(await Db.table(users).count()).toBe(4)
  })

  it('types getData(), value() and column() from the table and field() aliases (items 7, 11)', async () => {
    await seed()
    const user = await User.findOrFail(1)
    expectTypeOf(user.getData()).toEqualTypeOf<Row<typeof users>>()
    expect(user.getData().name).toBe('Ada')

    const names = await User.where('status', 1).order('id').column('name')
    expectTypeOf(names).toEqualTypeOf<string[]>()
    expect(names).toEqual(['Ada', 'Cleo'])
    const email = await User.where('id', 1).value('email')
    expectTypeOf(email).toEqualTypeOf<string | null | undefined>()
    expect(email).toBe('ada@example.com')
    expectTypeOf(await User.query().max('age')).toEqualTypeOf<number | null>()

    // field() 的别名
    const total = await Db.table(posts).field({
      total: count(),
    }).value('total')
    expectTypeOf(total).toEqualTypeOf<number | undefined>()
    expect(Number(total)).toBe(3)
    const titles = await Db.table(posts).field({ heading: posts.title, owner: posts.userId }).order('id').column('heading', 'owner')
    expectTypeOf(titles).toEqualTypeOf<Record<string, string>>()
    expect(titles).toEqual({ 1: 'World', 2: 'Bob post' })
    expect(await Db.table(posts).field('title as heading').order('id').column('heading')).toEqual(['Hello', 'World', 'Bob post'])
  })

  it('exists() selects a constant and paginate() skips the order in the count (items 8, 9)', async () => {
    await seed()
    queries.length = 0
    expect(await Db.table(users).where('age', '>', 30).order('name').exists()).toBe(true)
    expect(await User.where('age', '>', 99).exists()).toBe(false)
    expect(await Db.table(posts).group('userId').having('count(*) > ?', [1]).exists()).toBe(true)
    expect(queries[0]).toMatch(/select 1 from/)
    expect(queries[0]).not.toContain('order by')

    queries.length = 0
    const page = await User.order('id', 'desc').paginate(1, 2)
    expect(page).toMatchObject({ total: 3, lastPage: 2 })
    expect(page.data.map(user => user.name)).toEqual(['Cleo', 'Bob'])
    const countQuery = queries.find(query => query.includes('count('))!
    expect(countQuery).not.toContain('order by')

    // 事务中依次执行：没有数据时不再取数据
    if (dialect.connection.driver !== 'd1') {
      await transaction(async () => {
        queries.length = 0
        const empty = await User.where('age', '>', 99).paginate(1, 10)
        expect(empty).toMatchObject({ data: [], total: 0, lastPage: 1 })
        expect(queries.filter(query => query.includes('select'))).toHaveLength(1)
      })
    }
  })

  it('order() takes a direction for SQL expressions (item 10)', async () => {
    await seed()
    expect(await Db.table(posts).order(sql`${posts.views} * 2`, 'desc').column('views')).toEqual([50, 5, 1])
    expect(await Db.table(posts).order(sql`${posts.views} * 2`, 'asc').column('views')).toEqual([1, 5, 50])
    expect(await Db.table(posts).order(sql`${posts.views} desc`).column('views')).toEqual([50, 5, 1])
  })

  it('previews write statements with toSQL() (item 12)', async () => {
    const insert = await Db.table(users).toSQL('insert', { name: 'Ada' })
    expect(insert.sql.toLowerCase()).toMatch(/^insert into/)
    expect(insert.params).toContain('Ada')
    const update = await Db.table(users).where('id', 1).toSQL('update', { name: 'Bob', age: undefined })
    expect(update.sql.toLowerCase()).toMatch(/^update/)
    expect(update.params).toEqual(expect.arrayContaining(['Bob', 1]))
    expect((await Db.table(users).toSQL('delete', [1, 2])).sql.toLowerCase()).toMatch(/^delete from/)
    // 软删除模型的 delete 是 update
    expect((await User.query().toSQL('delete', 1)).sql.toLowerCase()).toMatch(/^update .*deleted_at/)
    await expect(Db.table(users).toSQL('delete')).rejects.toThrow(/without conditions/)
    expect(await Db.table(users).count()).toBe(0)
  })

  it('selectInsert() can ignore duplicates (item 13)', async () => {
    await seed()
    await Db.table(articles).insert({ title: 'existing', slug: 'ada@example.com' })
    const source = () => Db.table(users).whereNotNull('email').field({ title: users.name, slug: users.email })
    await expect(source().selectInsert(articles)).rejects.toBeInstanceOf(UniqueConstraintException)
    expect(await source().selectInsert(articles, { ignore: true })).toBe(1)
    expect(await Db.table(articles).order('id').column('title')).toEqual(['existing', 'Bob'])
  })

  it('supports more row lock modes (item 22)', async () => {
    const preview = async (query: { toSQL: () => Promise<{ sql: string }> }) => (await query.toSQL()).sql.toLowerCase()
    if (kind === 'sqlite') {
      expect(await preview(Db.table(users).lock('no key update', { skipLocked: true }))).not.toContain(' for ')
      return
    }
    expect(await preview(Db.table(users).lock('update', { skipLocked: true }))).toMatch(/for update skip locked$/)
    expect(await preview(Db.table(users).lock('share', { noWait: true }))).toMatch(/for share nowait$/)
    await expect(Db.table(users).lock('update', { skipLocked: true, noWait: true }).toSQL()).rejects.toThrow(/cannot be used together/)
    if (kind === 'postgres') {
      expect(await preview(Db.table(users).lock('no key update'))).toMatch(/for no key update$/)
      expect(await preview(Db.table(users).lock('key share', { skipLocked: true }))).toMatch(/for key share skip locked$/)
      await seed()
      await transaction(async () => {
        expect(await Db.table(users).where('id', 1).lock('no key update', { skipLocked: true }).value('name')).toBe('Ada')
      })
    }
    else {
      await expect(Db.table(users).lock('key share').toSQL()).rejects.toThrow(/only supported on PostgreSQL/)
    }
  })

  it('updates by primary key in one statement with updateById() (item 23)', async () => {
    await seed()
    await User.destroy(2)
    queries.length = 0
    expect(await User.updateById(1, { name: 'Ada L', email: 'new@example.com', age: undefined })).toBe(1)
    expect(queries.filter(query => query.includes('select'))).toHaveLength(0)
    expect(User.events).toEqual([])
    const ada = await User.findOrFail(1)
    expect(ada.name).toBe('Ada L')
    // 只读字段不写入，updatedAt 被维护
    expect(ada.email).toBe('ada@example.com')
    expect(ada.updatedAt).toBeInstanceOf(Date)
    // 软删除的行不更新
    expect(await User.updateById([2, 3], { age: 1 })).toBe(1)
    await expect(User.updateById(1, { email: 'x' })).rejects.toThrow(/without data/)

    // 乐观锁：版本加 1，之前读取的模型保存时冲突
    const article = await Article.create({ title: 'One' })
    expect(await Article.updateById(article.id, { title: 'Two' })).toBe(1)
    expect(await Db.table(articles).where('id', article.id).value('lockVersion')).toBe(1)
    article.title = 'Three'
    await expect(article.save()).rejects.toThrow()
  })

  it('leaves the optimistic lock column to its default on create (item 24)', async () => {
    const doc = await Document.create({ title: 'Draft' })
    expect(doc.revision).toBe(1)
    doc.title = 'Final'
    await doc.save()
    expect(doc.revision).toBe(2)
    expect(await Db.table(docs).where('id', doc.id).value('revision')).toBe(2)
    // 列没有默认值以外的情况保持原样：显式赋值优先
    expect((await Document.create({ title: 'Imported', revision: 7 })).revision).toBe(7)
  })
})

describe('unique constraint responses', () => {
  it('renders code unique_violation and translates the message (item 25)', async () => {
    const app = await createApplication({
      mode: 'test',
      env: false,
      config: {
        logger: { level: 'silent' },
        i18n: {
          defaultLocale: 'en',
          fallbackLocale: 'en',
          locales: ['en', 'zh-CN'],
        },
      },
      routes: [
        defineRoutes((r) => {
          r.post('/users', () => {
            throw new UniqueConstraintException(Object.assign(new Error('duplicate key value violates unique constraint "users_email_key"'), {
              code: '23505',
              constraint: 'users_email_key',
              table: 'users',
              detail: 'Key (email)=(ada@example.com) already exists.',
            }))
          })
        }),
      ],
    })
    try {
      const reply = async (locale: string) => {
        const res = await app.request('/users', {
          method: 'POST',
          headers: { 'accept-language': locale },
        })
        return [res.status, await res.json()]
      }
      expect(await reply('en')).toEqual([
        409,
        { code: 'unique_violation', message: 'The record already exists.', data: null },
      ])
      expect(await reply('zh-CN')).toEqual([
        409,
        { code: 'unique_violation', message: '数据已存在（违反唯一约束）', data: null },
      ])
    }
    finally {
      await app.dispose()
    }
  })

  it('parses driver errors along the cause chain', () => {
    const wrapped = (cause: object) => new UniqueConstraintException(Object.assign(new Error('Failed query'), { cause }))
    expect(wrapped(Object.assign(new Error('duplicate'), {
      code: '23505',
      constraint_name: 'users_email_key',
      table_name: 'users',
      detail: 'Key (email, "tenantId")=(a, 1) already exists.',
    })))
      .toMatchObject({
        constraint: 'users_email_key',
        table: 'users',
        columns: ['email', 'tenantId'],
      })
    expect(wrapped(Object.assign(new Error('Duplicate entry \'a\' for key \'users.users_email_unique\''), { code: 'ER_DUP_ENTRY', errno: 1062 })))
      .toMatchObject({ constraint: 'users_email_unique', table: 'users' })
    expect(wrapped(new Error('D1_ERROR: UNIQUE constraint failed: users.email, users.name: SQLITE_CONSTRAINT')))
      .toMatchObject({
        table: 'users',
        columns: ['email', 'name'],
      })
    expect(wrapped(Object.assign(new Error('E11000 duplicate key error collection: app.users index: email_1 dup key: { email: "a" }'), {
      code: 11000,
      keyPattern: { email: 1 },
    })))
      .toMatchObject({
        constraint: 'email_1',
        table: 'users',
        columns: ['email'],
      })
  })
})

describe('model.update() typing', () => {
  it('accepts the primary key next to the values, including generated identity keys', () => {
    // generatedAlwaysAsIdentity 的主键不在插入类型中，但按主键更新时要写在数据里
    const accounts = pgTable('accounts', {
      id: pgInt().primaryKey().generatedAlwaysAsIdentity(),
      name: pgText().notNull(),
    })
    class Account extends Model.define(accounts) {}
    const _update = () => Account.update({ id: 1, name: 'Ada' })
    expectTypeOf(_update).returns.toEqualTypeOf<Promise<number>>()
    // @ts-expect-error 未知的列
    const _unknown = () => Account.update({ id: 1, nickname: 'Ada' })
  })
})
