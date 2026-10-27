import type { ModelQuery } from '../src'
import type { Schema } from './schemas'
import { createApplication, defineRoutes } from '@think-h3/core'
import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { DatabaseError, DatabaseManager, databaseProvider, Db, migrate, Model, ModelNotFoundException, runMigrations, setDatabaseManager, UniqueConstraintException } from '../src'
import { dialects } from './schemas'

function defineModels(schema: Schema, events: string[]) {
  class User extends Model.define(schema.users) {
    static override softDelete = true
    static override hidden = ['email']
    static override append = ['label']

    getLabelAttr() {
      return `${this.name}#${this.id}`
    }

    setNameAttr(value: string) {
      return value.trim()
    }

    posts() {
      return this.hasMany(Post, 'userId')
    }

    profile() {
      return this.hasOne(Profile, 'userId')
    }

    static scopeAdults(query: ModelQuery<User>, min = 18) {
      query.where('age', '>=', min)
    }

    onBeforeInsert() {
      events.push(`beforeInsert:${this.name}`)
    }

    onAfterUpdate() {
      events.push(`afterUpdate:${this.name}`)
    }

    onBeforeDelete() {
      events.push(`beforeDelete:${this.name}`)
    }
  }

  class Post extends Model.define(schema.posts) {
    author() {
      return this.belongsTo(User, 'userId')
    }
  }

  class Profile extends Model.define(schema.profiles) {}

  return { User, Post, Profile }
}

describe.each(dialects)('orm on $name', (dialect) => {
  const { users, posts } = dialect.schema
  const events: string[] = []
  const { User, Post, Profile } = defineModels(dialect.schema, events)
  let manager: DatabaseManager

  beforeAll(async () => {
    await dialect.setup?.()
  })

  beforeEach(async () => {
    manager = new DatabaseManager({
      default: 'main',
      connections: { main: dialect.connection },
    })
    setDatabaseManager(manager)
    // 内存库：关闭即丢弃，重新打开得到全新数据库
    await manager.close()
    for (const statement of dialect.ddl)
      await Db.execute(sql.raw(statement))
    events.length = 0
  })

  afterAll(async () => {
    await manager.close()
    await dialect.dispose?.()
  })

  async function seed() {
    await Db.table(users).insert([
      {
        name: 'Ada',
        email: 'ada@example.com',
        age: 36,
        status: 1,
      },
      {
        name: 'Bob',
        email: 'bob@example.com',
        age: 17,
        status: 0,
      },
      {
        name: 'Cleo',
        email: null,
        age: 25,
        status: 1,
      },
      {
        name: 'Dan',
        email: 'dan@example.com',
        age: null,
        status: 1,
      },
    ])
  }

  describe('query builder', () => {
    it('inserts and returns full rows', async () => {
      const rows = await Db.table(users).insert([
        { name: 'Ada' },
        { name: 'Bob', age: 3 },
      ])
      expect(rows.map(row => [row.name, row.status, row.age])).toEqual([
        ['Ada', 1, null],
        ['Bob', 1, 3],
      ])
      expect(typeof rows[0].id).toBe('number')
      expect(await Db.table(users).insertGetId({ name: 'Cleo' })).toBe(3)
    })

    it('supports thinkphp-style where variants', async () => {
      await seed()
      const names = async (query: ReturnType<typeof Db.table<typeof users>>) =>
        (await query.order('id').select()).map(row => row.name)

      expect(await names(Db.table(users).where('status', 1))).toEqual(['Ada', 'Cleo', 'Dan'])
      expect(await names(Db.table(users).where('age', '>', 20))).toEqual(['Ada', 'Cleo'])
      expect(await names(Db.table(users).where({ status: 1, email: null }))).toEqual(['Cleo'])
      expect(await names(Db.table(users).where('name', ['Bob', 'Dan']))).toEqual(['Bob', 'Dan'])
      expect(await names(Db.table(users).whereIn('id', [1, 3]))).toEqual(['Ada', 'Cleo'])
      expect(await names(Db.table(users).whereNull('age'))).toEqual(['Dan'])
      expect(await names(Db.table(users).whereBetween('age', [17, 25]))).toEqual(['Bob', 'Cleo'])
      expect(await names(Db.table(users).whereLike('name', '%n'))).toEqual(['Dan'])
      expect(await names(Db.table(users).where(eq(users.name, 'Ada')))).toEqual(['Ada'])
      // (status = 0) OR (age > 30 AND email IS NOT NULL)
      expect(await names(Db.table(users).where('status', 0).orWhere(q => q.where('age', '>', 30).whereNotNull('email')))).toEqual(['Ada', 'Bob'])
      expect(await names(Db.table(users).when('', q => q.where('id', 0)).when(2, (q, min) => q.where('id', '>', min)))).toEqual(['Cleo', 'Dan'])
    })

    it('orders, limits, picks fields and aggregates', async () => {
      await seed()
      expect(await Db.table(users).order('age', 'desc').whereNotNull('age').field('name').select()).toEqual([
        { name: 'Ada' },
        { name: 'Cleo' },
        { name: 'Bob' },
      ])
      expect((await Db.table(users).order({ id: 'desc' }).page(2, 3).select()).map(row => row.name)).toEqual(['Ada'])
      expect(await Db.table(users).where('id', 2).value('name')).toBe('Bob')
      expect(await Db.table(users).order('id').column('name')).toEqual(['Ada', 'Bob', 'Cleo', 'Dan'])
      expect(await Db.table(users).count()).toBe(4)
      expect(await Db.table(users).where('status', 1).count()).toBe(3)
      expect(await Db.table(users).sum('age')).toBe(78)
      expect(await Db.table(users).avg('age')).toBe(26)
      expect(await Db.table(users).max('age')).toBe(36)
      expect(await Db.table(users).min('age')).toBe(17)
      expect(await Db.table(users).where('name', 'Zed').exists()).toBe(false)
      expect(await Db.table(users).where('name', 'Zed').find()).toBeUndefined()
      await expect(Db.table(users).where('name', 'Zed').findOrFail()).rejects.toBeInstanceOf(ModelNotFoundException)
    })

    it('paginates and chunks', async () => {
      await seed()
      const page = await Db.table(users).order('id').paginate(2, 3)
      expect({
        ...page,
        data: page.data.map(row => row.name),
      }).toEqual({
        data: ['Dan'],
        total: 4,
        page: 2,
        perPage: 3,
        lastPage: 2,
      })
      const batches: string[][] = []
      await Db.table(users).order('id').chunk(3, rows => void batches.push(rows.map(row => row.name)))
      expect(batches).toEqual([
        ['Ada', 'Bob', 'Cleo'],
        ['Dan'],
      ])
    })

    it('updates, increments and deletes with affected counts, refusing unconditional writes', async () => {
      await seed()
      expect(await Db.table(users).where('status', 1).update({ status: 2 })).toBe(3)
      expect(await Db.table(users).where('id', 1).increment('status', 3)).toBe(1)
      expect(await Db.table(users).where('id', 1).value('status')).toBe(5)
      await expect(Db.table(users).update({ status: 0 })).rejects.toThrow(/without conditions/)
      await expect(Db.table(users).delete()).rejects.toThrow(/without conditions/)
      expect(await Db.table(users).where('age', '<', 18).delete()).toBe(1)
      expect(await Db.table(users).delete({ all: true })).toBe(3)
    })

    it('exposes generated sql', async () => {
      const { sql: text, params } = await Db.table(users).where('status', 1).order('id', 'desc').limit(5).toSQL()
      expect(text.toLowerCase()).toContain('where')
      expect(text.toLowerCase()).toContain('order by')
      expect(params).toContain(1)
    })
  })

  it('translates unique constraint violations into 409 exceptions', async () => {
    await Db.execute(sql.raw('create unique index users_email_unique on users (email)'))
    await User.create({ name: 'Ada', email: 'ada@example.com' })
    const error = await User.create({ name: 'Copy', email: 'ada@example.com' }).catch(error => error)
    expect(error).toBeInstanceOf(UniqueConstraintException)
    expect(error.status).toBe(409)
  })

  it('runs embedded migrations once, recording them like drizzle', async () => {
    // D1 / MySQL 的库不随连接关闭而重建
    for (const statement of [
      'drop table if exists notes',
      dialect.name === 'pglite'
        ? 'drop schema if exists drizzle cascade'
        : 'drop table if exists __drizzle_migrations',
    ])
      await Db.execute(sql.raw(statement))
    const files = (folder: string) => ({
      [`${folder}/meta/_journal.json`]: JSON.stringify({
        entries: [
          { tag: '0000_init', when: 1700000000000, breakpoints: true },
          { tag: '0001_seed', when: 1700000001000, breakpoints: true },
        ],
      }),
      [`${folder}/0000_init.sql`]: 'create table notes (id integer primary key, body varchar(50));\n--> statement-breakpoint\ncreate index notes_body on notes (body);',
      [`${folder}/0001_seed.sql`]: `insert into notes (id, body) values (1, 'hi');`,
    })
    expect(await migrate({
      folder: 'db',
      files: files('db'),
    })).toEqual({
      connection: 'main',
      folder: 'db',
      applied: 2,
      total: 2,
    })
    expect(await runMigrations({
      files: files('database/migrations'),
    })).toEqual([
      {
        connection: 'main',
        folder: 'database/migrations',
        applied: 0,
        total: 2,
      },
    ])
    expect(await Db.execute(sql.raw('select body from notes'))).toEqual([
      { body: 'hi' },
    ])
    await expect(runMigrations({ files: {} })).rejects.toThrow('No migrations for connection "main"')
  })

  it.runIf(dialect.connection.driver === 'd1')('rejects interactive transactions on D1 with a hint', async () => {
    await expect(Db.transaction(async () => {})).rejects.toThrow(DatabaseError)
    await expect(Db.transaction(async () => {})).rejects.toThrow('batch')
  })

  describe.skipIf(dialect.connection.driver === 'd1')('transactions', () => {
    it('commits, rolls back on error and propagates implicitly to models', async () => {
      await Db.transaction(async () => {
        await Db.table(users).insert({ name: 'In tx' })
        await User.create({ name: 'Model in tx' })
      })
      expect(await Db.table(users).count()).toBe(2)

      await expect(Db.transaction(async () => {
        await User.create({ name: 'Rolled back' })
        throw new Error('boom')
      })).rejects.toThrow('boom')
      expect(await User.where('name', 'Rolled back').count()).toBe(0)
    })

    it('supports nested transactions with savepoints', async () => {
      await Db.transaction(async () => {
        await Db.table(users).insert({ name: 'outer' })
        await Db.transaction(async () => {
          await Db.table(users).insert({ name: 'inner' })
          throw new Error('inner failed')
        }).catch(() => {})
      })
      expect(await Db.table(users).column('name')).toEqual(['outer'])
    })
  })

  describe('model', () => {
    it('creates with mutators, timestamps and events, and finds by key', async () => {
      const user = await User.create({ name: '  Ada  ', age: 36 })
      expect(user.exists).toBe(true)
      expect(user.name).toBe('Ada')
      expect(user.createdAt).toBeInstanceOf(Date)
      expect(user.updatedAt).toBeInstanceOf(Date)
      expect(events).toEqual(['beforeInsert:Ada'])

      const found = await User.findOrFail(user.id)
      expect(found).toBeInstanceOf(User)
      expect(found.name).toBe('Ada')
      await expect(User.findOrFail(999)).rejects.toThrow('User 999 不存在')
    })

    it('saves only dirty fields and refreshes updatedAt', async () => {
      const user = await User.create({ name: 'Ada', age: 30 })
      const before = user.updatedAt!.getTime()
      await new Promise(resolve => setTimeout(resolve, 1100))
      user.age = 31
      expect(user.isDirty('age')).toBe(true)
      expect(user.isDirty('name')).toBe(false)
      await user.save()
      expect(user.isDirty()).toBe(false)
      expect(events).toContain('afterUpdate:Ada')
      const fresh = await User.findOrFail(user.id)
      expect(fresh.age).toBe(31)
      expect(fresh.updatedAt!.getTime()).toBeGreaterThan(before)
    })

    it('serializes with accessors, hidden and appended fields', async () => {
      const user = await User.create({ name: 'Ada', email: 'secret@example.com' })
      const json = user.toJSON()
      expect(json.label).toBe(`Ada#${user.id}`)
      expect(json).not.toHaveProperty('email')
      expect(JSON.parse(JSON.stringify([user]))[0].name).toBe('Ada')
    })

    it('soft deletes, restores and force deletes', async () => {
      const [ada, bob] = [await User.create({ name: 'Ada' }), await User.create({ name: 'Bob' })]
      await bob.delete()
      expect(bob.trashed()).toBe(true)
      expect(events).toContain('beforeDelete:Bob')
      expect((await User.all()).map(user => user.name)).toEqual(['Ada'])
      expect(await User.withTrashed().count()).toBe(2)
      expect((await User.onlyTrashed().select()).map(user => user.name)).toEqual(['Bob'])
      expect(await User.find(bob.id)).toBeUndefined()

      await (await User.onlyTrashed().findOrFail(bob.id)).restore()
      expect(await User.count()).toBe(2)

      await ada.forceDelete()
      expect(await User.withTrashed().count()).toBe(1)
      expect(await User.destroy([bob.id])).toBe(1)
      expect(await User.onlyTrashed().count()).toBe(1)
      expect(await User.where('name', 'Bob').delete()).toBe(0)
    })

    it('applies scopes and paginates models', async () => {
      await seed()
      expect((await User.scope('adults').order('id').select()).map(user => user.name)).toEqual(['Ada', 'Cleo'])
      expect((await User.scope('adults', 30).select()).map(user => user.name)).toEqual(['Ada'])
      const page = await User.where('status', 1).order('id').paginate(1, 2)
      expect(page.total).toBe(3)
      expect(page.data[0]).toBeInstanceOf(User)
    })
  })

  describe('relations', () => {
    async function seedRelations() {
      const ada = await User.create({ name: 'Ada' })
      const bob = await User.create({ name: 'Bob' })
      await Db.table(posts).insert([
        { userId: ada.id, title: 'Ada 1' },
        { userId: ada.id, title: 'Ada 2' },
        { userId: bob.id, title: 'Bob 1' },
      ])
      await Profile.create({ userId: ada.id, bio: 'Mathematician' })
      return { ada, bob }
    }

    it('loads lazily by awaiting the relation', async () => {
      const { ada, bob } = await seedRelations()
      expect((await ada.posts()).map(post => post.title)).toEqual(['Ada 1', 'Ada 2'])
      expect((await ada.profile())?.bio).toBe('Mathematician')
      expect(await bob.profile()).toBeNull()
      const post = await Post.where('title', 'Bob 1').findOrFail()
      expect((await post.author())?.name).toBe('Bob')
      expect(await ada.posts().query().where('title', 'Ada 2').count()).toBe(1)
    })

    it('eager loads with nesting and includes relations in json', async () => {
      await seedRelations()
      const list = await User.with('posts', 'profile', 'posts.author').order('id').select()
      expect(list[0].getRelation('posts')?.map(post => post.title)).toEqual(['Ada 1', 'Ada 2'])
      expect(list[0].getRelation('profile')?.bio).toBe('Mathematician')
      expect(list[1].getRelation('profile')).toBeNull()
      expect(list[0].getRelation('posts')?.[0].getRelation('author')?.name).toBe('Ada')

      const json = JSON.parse(JSON.stringify(list[1]))
      expect(json.posts).toEqual([
        {
          id: 3,
          userId: list[1].id,
          title: 'Bob 1',
          views: 0,
          author: expect.objectContaining({ name: 'Bob' }),
        },
      ])
    })
  })

  describe('framework integration', () => {
    it('serves models through the unified response format', async () => {
      const app = await createApplication({
        mode: 'test',
        env: false,
        config: {
          database: {
            default: 'main',
            connections: { main: dialect.connection },
          },
        },
        providers: [
          databaseProvider(),
        ],
        routes: [
          defineRoutes((r) => {
            r.get('/users/:id', ctx => User.findOrFail(Number(ctx.param('id'))))
            r.get('/users', () => User.order('id').paginate(1, 10))
          }),
        ],
      })
      const ada = await User.create({ name: 'Ada' })
      expect(app.make(DatabaseManager)).toBeInstanceOf(DatabaseManager)

      const one = await (await app.request(`/users/${ada.id}`)).json() as any
      expect(one).toMatchObject({
        code: 0,
        data: { name: 'Ada', label: `Ada#${ada.id}` },
      })
      expect(one.data).not.toHaveProperty('email')

      const missing = await app.request('/users/999')
      expect([missing.status, (await missing.json() as any).message]).toEqual([404, 'User 999 不存在'])

      const page = await (await app.request('/users')).json() as any
      expect(page.data).toMatchObject({
        total: 1,
        page: 1,
        data: [
          { name: 'Ada' },
        ],
      })
    })
  })
})
