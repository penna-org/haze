import type { ModelQuery } from '../src'
import type { Schema } from './schemas'
import { CacheManager, Config, setCacheManager, useCacheManager } from '@hazejs/core'
import { count, eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { DatabaseManager, Db, Model, ModelNotFoundException, OptimisticLockException, setDatabaseManager } from '../src'
import { dialects } from './schemas'

function defineModels(schema: Schema) {
  class User extends Model.define(schema.users) {
    static override softDelete = true
    static override readonly = ['email']

    posts() {
      return this.hasMany(Post, 'userId')
    }

    popularPosts() {
      return this.hasMany(Post, 'userId').where('views', '>=', 10).order('views', 'desc')
    }

    profile() {
      return this.hasOne(Profile, 'userId')
    }

    profileBio() {
      return this.hasOne(Profile, 'userId').bind({ bio: 'bio' })
    }

    profileOrDefault() {
      return this.hasOne(Profile, 'userId').withDefault({ bio: 'none' })
    }

    comments() {
      return this.hasManyThrough(Comment, Post, 'userId', 'postId').order('id')
    }

    firstComment() {
      return this.hasOneThrough(Comment, Post, 'userId', 'postId')
    }

    avatar() {
      return this.morphOne(Image, 'imageable')
    }

    static searchNameAttr(query: ModelQuery<User>, value: unknown) {
      if (value)
        query.whereLike('name', `${String(value)}%`)
    }

    static scopeActive(query: ModelQuery<User>) {
      query.where('status', 1)
    }
  }

  /** 全局作用域：只查询 status = 1 */
  class ActiveUser extends Model.define(schema.users) {
    static override globalScope = ['active']

    static scopeActive(query: ModelQuery<ActiveUser>) {
      query.where('status', 1)
    }
  }

  class Post extends Model.define(schema.posts) {
    author() {
      return this.belongsTo(User, 'userId')
    }

    tags() {
      return this.belongsToMany(Tag, schema.postTag, 'tagId', 'postId').order('id')
    }

    comments() {
      return this.hasMany(Comment, 'postId')
    }

    images() {
      return this.morphMany(Image, 'imageable').order('id')
    }
  }

  class Tag extends Model.define(schema.tags) {
    posts() {
      return this.belongsToMany(Post, schema.postTag, 'postId', 'tagId')
    }
  }

  class Comment extends Model.define(schema.comments) {}

  class Profile extends Model.define(schema.profiles) {}

  class Image extends Model.define(schema.images) {
    imageable() {
      return this.morphTo('imageable', { User, Post })
    }
  }

  class Article extends Model.define(schema.articles) {
    static override optimLock = true

    onBeforeDelete() {
      if (this.title === 'keep')
        return false
    }
  }

  return {
    User,
    ActiveUser,
    Post,
    Tag,
    Comment,
    Profile,
    Image,
    Article,
  }
}

describe.each(dialects)('advanced orm on $name', (dialect) => {
  const { users, posts, tags, articles } = dialect.schema
  const { User, ActiveUser, Post, Tag, Comment, Profile, Image, Article } = defineModels(dialect.schema)
  const transactional = dialect.connection.driver !== 'd1'
  let manager: DatabaseManager

  beforeAll(async () => {
    await dialect.setup?.()
    setCacheManager(new CacheManager(new Config({})))
  })

  beforeEach(async () => {
    manager = new DatabaseManager({
      default: 'main',
      connections: { main: dialect.connection },
    })
    setDatabaseManager(manager)
    await manager.close()
    for (const statement of dialect.ddl)
      await Db.execute(sql.raw(statement))
    await useCacheManager().store().flush()
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
    ])
    await Db.table(posts).insert([
      { userId: 1, title: 'First', views: 5 },
      { userId: 1, title: 'Second', views: 20 },
      { userId: 1, title: 'Third', views: 12 },
      { userId: 2, title: 'Bobs', views: 1 },
    ])
  }

  const names = (rows: Array<{ name: unknown }>) => rows.map(row => row.name)

  describe.skipIf(!transactional)('transactions', () => {
    it('commits and rolls back manual transactions', async () => {
      await Db.startTrans()
      expect(Db.inTransaction()).toBe(true)
      await User.create({ name: 'Ada' })
      await Db.commit()
      expect(Db.inTransaction()).toBe(false)

      await Db.startTrans()
      await User.create({ name: 'Bob' })
      expect(await User.count()).toBe(2)
      await Db.rollback()
      expect(names(await User.all())).toEqual(['Ada'])
    })

    it('nests manual transactions with savepoints and mixes with callbacks', async () => {
      await Db.startTrans()
      await Db.table(users).insert({ name: 'Outer' })
      await Db.startTrans()
      await Db.table(users).insert({ name: 'Inner' })
      await Db.rollback()
      await Db.transaction(async () => {
        await Db.table(users).insert({ name: 'Callback' })
      })
      await Db.commit()
      expect(names(await Db.table(users).order('id').select())).toEqual(['Outer', 'Callback'])
      await expect(Db.commit()).rejects.toThrow(/No transaction started/)
    })

    it('runs model transactions on the model connection and passes options', async () => {
      await expect(User.transaction(async () => {
        await User.create({ name: 'Ada' })
        throw new Error('boom')
      })).rejects.toThrow('boom')
      expect(await User.count()).toBe(0)
      const config = dialect.connection.driver === 'sqlite' || dialect.connection.driver === 'turso'
        ? { behavior: 'immediate' as const }
        : dialect.connection.driver === 'mysql' || dialect.connection.driver === 'pglite'
          ? { isolationLevel: 'serializable' as const }
          : {}
      await Db.transaction(async () => {
        await User.create({ name: 'Bob' })
      }, config)
      expect(await User.count()).toBe(1)
    })

    it('locks rows inside a transaction', async () => {
      await seed()
      const row = await Db.transaction(() => Db.table(users).where('id', 1).lock().find())
      expect(row?.name).toBe('Ada')
    })
  })

  describe('conditions', () => {
    it('supports whereOr, whereNot, array conditions, whereColumn, whereRaw and whereExp', async () => {
      await seed()
      const query = () => Db.table(users).order('id')
      expect(names(await query().where('status', 0).whereOr('age', '>', 30).select())).toEqual(['Ada', 'Bob'])
      expect(names(await query().whereNot(q => q.where('status', 0).orWhere('age', '>', 30)).select())).toEqual(['Cleo'])
      expect(names(await query().where([
        ['status', '=', 1],
        ['age', '<', 30],
      ]).select())).toEqual(['Cleo'])
      expect(names(await query().whereColumn('id', '<', 'age').whereColumn('status', 'status').select())).toEqual(['Ada', 'Bob', 'Cleo'])
      expect(names(await query().whereRaw('age > ? and status = ?', [20, 1]).select())).toEqual(['Ada', 'Cleo'])
      expect(names(await query().whereRaw(sql`${users.age} < ${20}`).orWhereRaw('id = ?', [3]).select())).toEqual(['Bob', 'Cleo'])
      expect(names(await query().whereExp('age', '>= 25').select())).toEqual(['Ada', 'Cleo'])
      expect(names(await query().when('', q => q.where('id', 1), q => q.where('id', 2)).select())).toEqual(['Bob'])
    })

    it('uses subqueries in whereIn, where and whereExists', async () => {
      await seed()
      const authors = Db.table(posts).field('userId')
      expect(names(await Db.table(users).whereIn('id', authors).order('id').select())).toEqual(['Ada', 'Bob'])
      expect(names(await Db.table(users).whereNotIn('id', authors).select())).toEqual(['Cleo'])
      expect(names(await Db.table(users).where('id', '=', Db.table(posts).field('userId').where('title', 'Bobs')).select())).toEqual(['Bob'])
      const popular = Db.table(posts).where(eq(posts.userId, users.id)).where('views', '>', 10)
      expect(names(await Db.table(users).whereExists(popular).select())).toEqual(['Ada'])
      expect(names(await Db.table(users).whereNotExists(popular).order('id').select())).toEqual(['Bob', 'Cleo'])
    })

    it('queries json paths, json arrays and comma separated sets', async () => {
      await Db.table(articles).insert([
        {
          title: 'A',
          meta: {
            city: 'Paris',
            rank: 7,
            author: { name: 'Ada' },
          },
          labels: ['orm', 'sql'],
          tags: 'a,b,c',
        },
        {
          title: 'B',
          meta: {
            city: 'Rome',
            rank: 3,
            author: { name: 'Bob' },
          },
          labels: ['http'],
          tags: 'b',
        },
        {
          title: 'C',
          meta: {
            city: 'Paris',
            rank: 12,
            author: { name: 'Cleo' },
          },
          labels: [],
          tags: 'c,d',
        },
      ])
      const titles = (rows: Array<{ title: unknown }>) => rows.map(row => row.title)
      expect(titles(await Db.table(articles).where('meta->city', 'Paris').order('id').select())).toEqual(['A', 'C'])
      expect(titles(await Db.table(articles).where('meta->rank', '>', 5).order('id').select())).toEqual(['A', 'C'])
      expect(titles(await Db.table(articles).where('meta->author->name', 'Bob').select())).toEqual(['B'])
      expect(await Db.table(articles).order('meta->author->name', 'desc').column('title')).toEqual(['C', 'B', 'A'])
      expect(await Db.table(articles).where('id', 1).value('meta->city')).toBe('Paris')
      const rows = await Db.table(articles).field('title', 'meta->city as city').order('id').select()
      expect(rows.map(row => [row.title, row.city])).toEqual([
        ['A', 'Paris'],
        ['B', 'Rome'],
        ['C', 'Paris'],
      ])
      expect(titles(await Db.table(articles).whereJsonContains('labels', 'orm').select())).toEqual(['A'])
      expect(titles(await Db.table(articles).whereFindInSet('tags', 'b').order('id').select())).toEqual(['A', 'B'])
    })

    it('filters by time ranges', async () => {
      const now = new Date()
      const yesterday = new Date(now.getTime() - 24 * 3600 * 1000)
      const lastYear = new Date(now.getFullYear() - 1, 5, 15, 12)
      await Db.table(articles).insert([
        { title: 'today', publishedAt: now },
        { title: 'yesterday', publishedAt: yesterday },
        { title: 'last year', publishedAt: lastYear },
      ])
      const titles = async (query: ReturnType<typeof Db.table<typeof articles>>) => (await query.order('id').select()).map(row => row.title)
      expect(await titles(Db.table(articles).whereDay('publishedAt'))).toEqual(['today'])
      expect(await titles(Db.table(articles).whereDay('publishedAt', 'yesterday'))).toEqual(['yesterday'])
      expect(await titles(Db.table(articles).whereTime('publishedAt', 'today'))).toEqual(['today'])
      expect(await titles(Db.table(articles).whereYear('publishedAt', 'last year'))).toEqual(['last year'])
      expect(await titles(Db.table(articles).whereYear('publishedAt', now.getFullYear() - 1))).toEqual(['last year'])
      expect(await titles(Db.table(articles).whereMonth('publishedAt', `${lastYear.getFullYear()}-06`))).toEqual(['last year'])
      expect(await titles(Db.table(articles).whereTime('publishedAt', '<', yesterday.getTime() - 1000))).toEqual(['last year'])
      expect(await titles(Db.table(articles).whereBetweenTime('publishedAt', new Date(now.getTime() - 48 * 3600 * 1000), new Date(now.getTime() + 1000)))).toEqual(['today', 'yesterday'])
      expect(await titles(Db.table(articles).whereNotBetweenTime('publishedAt', new Date(now.getFullYear() - 1, 0, 1), new Date(now.getFullYear() - 1, 11, 31)))).toEqual(['today', 'yesterday'])
      expect(await titles(Db.table(articles).whereTimeInterval('publishedAt', new Date(now.getFullYear() - 1, 5, 1), 'month'))).toEqual(['last year'])
    })
  })

  describe('select', () => {
    it('joins tables with flat fields, nested rows and aliases', async () => {
      await seed()
      const rows = await Db.table(posts).join(users, 'posts.userId', 'users.id').field('posts.title', 'users.name as author').where('users.status', 1).order('posts.id').select()
      expect(rows).toEqual([
        { title: 'First', author: 'Ada' },
        { title: 'Second', author: 'Ada' },
        { title: 'Third', author: 'Ada' },
      ])
      const nested = await Db.table(users).leftJoin(posts, eq(users.id, posts.userId)).where('users.id', 3).select() as any[]
      expect(nested).toHaveLength(1)
      expect(nested[0].users.name).toBe('Cleo')
      expect(nested[0].posts).toBeNull()
      const pairs = await Db.table(users).alias('u').join([users, 'm'], 'u.status', 'm.status').field('u.name', 'm.name as mate').whereColumn('u.id', '<', 'm.id').select()
      expect(pairs).toEqual([
        { name: 'Ada', mate: 'Cleo' },
      ])
      expect(await Db.table(posts).join(users, 'posts.userId', 'users.id').where('users.name', 'Ada').count()).toBe(3)
      expect((await Db.table(posts).join(users, 'posts.userId', 'users.id').toSQL()).sql).toMatch(/join/i)
    })

    it('groups, filters groups, counts groups and picks distinct values', async () => {
      await seed()
      const totals = await Db.table(posts).field({
        userId: posts.userId,
        total: count(),
      }).group('userId').having('count(*) >= ?', [2]).select()
      expect(totals).toEqual([
        { userId: 1, total: 3 },
      ])
      expect(await Db.table(posts).field('userId').group('userId').count()).toBe(2)
      expect((await Db.table(users).field('status').distinct().order('status').select()).map(row => row.status)).toEqual([0, 1])
      expect(await Db.table(users).distinct().count()).toBe(3)
      expect(await Db.table(users).count('email')).toBe(2)
    })

    it('orders by raw expressions, value lists and random, and limits with an offset', async () => {
      await seed()
      expect(await Db.table(users).orderField('name', ['Cleo', 'Ada']).column('name')).toEqual(['Cleo', 'Ada', 'Bob'])
      expect(await Db.table(users).orderRaw('age desc').column('name')).toEqual(['Ada', 'Cleo', 'Bob'])
      expect((await Db.table(users).orderRand().select()).length).toBe(3)
      expect(await Db.table(users).order('id').limit(1, 2).column('name')).toEqual(['Bob', 'Cleo'])
      const totals = await Db.table(posts).field({
        userId: posts.userId,
        total: sql<number>`sum(${posts.views})`.mapWith(Number),
      }).group('userId').order('total', 'desc').select()
      expect(totals.map(row => row.userId)).toEqual([1, 2])
    })

    it('unions queries', async () => {
      await seed()
      const rows = await Db.table(users).field('name').where('id', 1).unionAll(Db.table(users).field('name').where('id', 3)).select()
      expect(names(rows).sort()).toEqual(['Ada', 'Cleo'])
      expect(await Db.table(users).field('status').union(Db.table(users).field('status')).count()).toBe(2)
    })

    it('reads values, keyed columns, partial fields and transformed attributes', async () => {
      await seed()
      expect(await Db.table(users).column('name', 'id')).toEqual({ 1: 'Ada', 2: 'Bob', 3: 'Cleo' })
      const keyed = await Db.table(users).column('*', 'name')
      expect(keyed.Bob.age).toBe(17)
      const row = await Db.table(users).withoutField('email', 'createdAt', 'updatedAt', 'deletedAt').where('id', 1).find()
      expect(row).toEqual({
        id: 1,
        name: 'Ada',
        status: 1,
        age: 36,
      })
      const raw = await Db.table(users).field('id').fieldRaw<number>('age * 2', 'double').where('id', 2).find()
      expect(Number(raw?.double)).toBe(34)
      const upper = await Db.table(users).withAttr('name', (value: string) => value.toUpperCase()).order('id').column('name')
      expect(upper).toEqual(['ADA', 'BOB', 'CLEO'])
      await expect(Db.table(users).where('id', 99).selectOrFail()).rejects.toBeInstanceOf(ModelNotFoundException)
    })

    it('iterates with cursors and paginates by cursor', async () => {
      await seed()
      const seen: string[] = []
      for await (const user of Db.table(users).cursor(2))
        seen.push(user.name)
      expect(seen).toEqual(['Ada', 'Bob', 'Cleo'])
      const ordered: string[] = []
      for await (const user of User.query().order('name', 'desc').lazy(2))
        ordered.push(user.name)
      expect(ordered).toEqual(['Cleo', 'Bob', 'Ada'])

      const first = await Db.table(posts).paginateX(3)
      expect(first.data.map(post => post.id)).toEqual([4, 3, 2])
      expect(first.hasMore).toBe(true)
      const next = await Db.table(posts).paginateX(3, { lastId: first.lastId })
      expect(next.data.map(post => post.id)).toEqual([1])
      expect(next.hasMore).toBe(false)
    })

    it('caches results and revives dates', async () => {
      const createdAt = new Date('2024-05-01T10:00:00Z')
      await Db.table(users).insert({ name: 'Ada', createdAt })
      const first = await Db.table(users).where('id', 1).cache('user:1', 60).find()
      await Db.table(users).where('id', 1).update({ name: 'Changed' })
      const cached = await Db.table(users).where('id', 1).cache('user:1', 60).find()
      expect(cached?.name).toBe('Ada')
      expect(cached?.createdAt).toBeInstanceOf(Date)
      expect(cached?.createdAt?.getTime()).toBe(first?.createdAt?.getTime())
      expect((await Db.table(users).where('id', 1).find())?.name).toBe('Changed')
      expect(await Db.table(users).cache().count()).toBe(1)
      await Db.table(users).insert({ name: 'Bob' })
      expect(await Db.table(users).cache().count()).toBe(1)
      const model = await User.where('id', 1).cache('model:1').find()
      expect(model?.name).toBe('Changed')
    })
  })

  describe('writes', () => {
    it('inserts ignoring duplicates, upserts and replaces', async () => {
      await Db.table(articles).insert({ title: 'Old', slug: 'a' })
      expect(await Db.table(articles).insertIgnore([
        { title: 'Dup', slug: 'a' },
        { title: 'New', slug: 'b' },
      ])).toBe(1)
      await Db.table(articles).upsert({ title: 'Updated', slug: 'a' }, { target: 'slug' })
      await Db.table(articles).upsert([
        { title: 'Third', slug: 'c' },
      ], { target: 'slug' })
      expect(await Db.table(articles).order('id').column('title')).toEqual(['Updated', 'New', 'Third'])
      const id = await Db.table(articles).where('slug', 'b').value('id') as number
      await Db.table(articles).replace({ id, title: 'Replaced', slug: 'b' })
      expect(await Db.table(articles).where('id', id).value('title')).toBe('Replaced')
      expect(await Db.table(articles).count()).toBe(3)
    })

    it('inserts from a select, saves, updates with pending data and deletes by key', async () => {
      await seed()
      expect(await Db.table(users).where('status', 1).field({ name: users.name }).selectInsert(tags)).toBe(2)
      expect(await Db.table(tags).order('id').column('name')).toEqual(['Ada', 'Cleo'])

      expect(await Db.table(tags).save({ name: 'New' })).toBe(1)
      expect(await Db.table(tags).save({ id: 1, name: 'Renamed' })).toBe(1)
      expect(await Db.table(tags).where('id', 1).value('name')).toBe('Renamed')

      await Db.table(posts).where('id', 1).inc('views', 5).dec('userId', 0).exp('title', sql`upper(${posts.title})`).update()
      expect(await Db.table(posts).where('id', 1).find()).toMatchObject({ views: 10, title: 'FIRST' })
      await Db.table(posts).data({ title: 'Data' }).where('id', 2).update()
      await Db.table(posts).update({ id: 3, title: 'By key' })
      expect(await Db.table(posts).order('id').column('title')).toEqual(['FIRST', 'Data', 'By key', 'Bobs'])

      expect(await Db.table(posts).delete(4)).toBe(1)
      expect(await Db.table(posts).delete([1, 2])).toBe(2)
      expect(await Db.table(posts).count()).toBe(1)
    })
  })

  describe('models', () => {
    it('applies global scopes unless disabled', async () => {
      await seed()
      expect(names(await ActiveUser.query().order('id').select())).toEqual(['Ada', 'Cleo'])
      expect(names(await ActiveUser.where('id', 2).orWhere('id', 1).select())).toEqual(['Ada'])
      expect(await ActiveUser.withoutGlobalScope().count()).toBe(3)
      expect(await ActiveUser.withoutGlobalScope(['active']).count()).toBe(3)
    })

    it('searches with searchers and plain fields', async () => {
      await seed()
      expect(names(await User.withSearch(['name', 'status'], { name: 'C', status: 1 }).select())).toEqual(['Cleo'])
      expect(names(await User.withSearch(['name', 'status'], { status: '' }).order('id').select())).toEqual(['Ada', 'Bob', 'Cleo'])
    })

    it('keeps readonly fields, limits mass assignment and forces updates', async () => {
      const user = await User.create({ name: 'Ada', email: 'ada@example.com', status: 3 }, ['name', 'email'])
      expect(user.status).toBe(1)
      user.email = 'changed@example.com'
      user.name = 'Ada L'
      await user.save()
      expect(user.email).toBe('ada@example.com')
      const fresh = await User.findOrFail(1)
      expect([fresh.name, fresh.email]).toEqual(['Ada L', 'ada@example.com'])

      await fresh.allowField(['age']).save({ age: 40, name: 'ignored' } as never)
      expect([fresh.age, fresh.name]).toEqual([40, 'Ada L'])

      const before = fresh.updatedAt
      await new Promise(resolve => setTimeout(resolve, 1100))
      await fresh.force().save()
      expect(fresh.updatedAt!.getTime()).toBeGreaterThan(before!.getTime())
    })

    it('increments on save and detects optimistic lock conflicts', async () => {
      const article = await Article.create({ title: 'A' })
      expect(article.lockVersion).toBe(0)
      article.title = 'B'
      await article.save()
      expect(article.lockVersion).toBe(1)

      const stale = await Article.findOrFail(1)
      const current = await Article.findOrFail(1)
      current.title = 'C'
      await current.save()
      stale.title = 'D'
      await expect(stale.save()).rejects.toBeInstanceOf(OptimisticLockException)

      const post = await Post.create({ userId: 1, title: 'P' })
      await post.inc('views', 3).save()
      await post.inc('views').save()
      expect(post.views).toBe(4)
      expect((await Post.findOrFail(post.id)).views).toBe(4)
    })

    it('updates, saves and destroys in bulk with events, and cancels from before events', async () => {
      await seed()
      expect(await User.update({ status: 2 }, { status: 1 })).toBe(2)
      expect(await User.update({ id: 2, name: 'Bobby' })).toBe(1)
      expect(await User.where('status', 2).count()).toBe(2)
      expect(names(await User.withTrashed().order('id').select())).toEqual(['Ada', 'Bobby', 'Cleo'])

      const saved = await User.saveAll([
        { id: 1, name: 'Ada 2' },
        { name: 'Dan' },
      ])
      expect(saved.map(user => [user.id, user.name])).toEqual([
        [1, 'Ada 2'],
        [4, 'Dan'],
      ])

      expect(await User.destroy(q => q.where('age', '<', 20))).toBe(1)
      expect(await User.onlyTrashed().count()).toBe(1)

      const keep = await Article.create({ title: 'keep' })
      expect(await keep.delete()).toBe(false)
      expect(await Article.count()).toBe(1)

      const empty = await User.findOrEmpty(99)
      expect(empty.isEmpty()).toBe(true)
      expect((await User.findOrEmpty(1)).isEmpty()).toBe(false)
    })

    it('serializes with dynamic hidden, visible, append and withAttr', async () => {
      await seed()
      const user = await User.with('posts').findOrFail(1)
      expect(Object.keys(user.visible(['id', 'name']).toJSON())).toEqual(['id', 'name'])
      const json = user.visible(['name', 'posts.title']).toJSON()
      expect(json).toEqual({
        name: 'Ada',
        posts: [
          { title: 'First' },
          { title: 'Second' },
          { title: 'Third' },
        ],
      })
      const hidden = user.visible([]).hidden(['email', 'posts']).append(['shout']).withAttr('shout', (_: unknown, data: Record<string, unknown>) => String(data.name).toUpperCase()).toJSON()
      expect(hidden.email).toBeUndefined()
      expect(hidden.posts).toBeUndefined()
      expect(hidden.shout).toBe('ADA')
      const listed = await User.query().visible(['name']).withAttr('name', (value: string) => `~${value}`).order('id').select()
      expect(listed.map(item => item.toJSON())).toEqual([
        { name: '~Ada' },
        { name: '~Bob' },
        { name: '~Cleo' },
      ])
      expect(user.toArray()).toEqual(user.toJSON())
    })
  })

  describe('relations', () => {
    it('eager loads with constraints and relation-level conditions', async () => {
      await seed()
      const [ada] = await User.with({
        posts: q => q.where('views', '>', 10).order('id', 'desc'),
      }).where('id', 1).select()
      expect(ada.getRelation('posts')!.map(post => post.title)).toEqual(['Third', 'Second'])
      const popular = await ada.popularPosts()
      expect(popular.map(post => post.title)).toEqual(['Second', 'Third'])
      const authors = await Post.with({
        author: q => q.field('id', 'name'),
      }, 'author.posts').order('id').select()
      expect(authors[0].getRelation('author')!.toJSON()).toMatchObject({ id: 1, name: 'Ada' })
      expect((authors[0].getRelation('author')!.getRelation('posts') as unknown[]).length).toBe(3)
    })

    it('counts and aggregates relations', async () => {
      await seed()
      const rows = await User.withCount('posts').withSum('posts', 'views').withMax('posts', 'views', undefined, 'topViews').withCount('posts', q => q.where('views', '>', 10), 'popular').order('id').select()
      expect(rows.map(user => [
        user.getAttr('postsCount'),
        user.getAttr('postsSum'),
        user.getAttr('topViews'),
        user.getAttr('popular'),
      ])).toEqual([
        [3, 37, 20, 2],
        [1, 1, 1, 0],
        [0, 0, null, 0],
      ])
      expect(rows[0].toJSON().postsCount).toBe(3)
      expect(rows[0].isDirty()).toBe(false)
    })

    it('filters by relation existence and counts', async () => {
      await seed()
      expect(names(await User.has('posts').order('id').select())).toEqual(['Ada', 'Bob'])
      expect(names(await User.has('posts', '>=', 2).select())).toEqual(['Ada'])
      expect(names(await User.has('posts', '=', 0).select())).toEqual(['Cleo'])
      expect(names(await User.hasWhere('posts', { title: 'Bobs' }).select())).toEqual(['Bob'])
      expect(names(await User.hasWhere('posts', q => q.where('views', '>', 15)).select())).toEqual(['Ada'])
      expect(names(await User.query().hasNot('posts').select())).toEqual(['Cleo'])
      expect(names(await User.where('id', 3).hasWhereOr('posts', { title: 'Bobs' }).order('id').select())).toEqual(['Bob', 'Cleo'])
      expect((await Post.has('author').count())).toBe(4)
    })

    it('writes through hasMany and belongsTo', async () => {
      await seed()
      const cleo = await User.findOrFail(3)
      const post = await cleo.posts().save({ title: 'Hello' })
      expect(post.userId).toBe(3)
      await cleo.posts().saveAll([
        { title: 'A' },
        new Post().fill({ title: 'B' }),
      ])
      expect(await cleo.posts().query().count()).toBe(3)

      const moved = await Post.findOrFail(1)
      await moved.author().associate(cleo)
      expect((await Post.findOrFail(1)).userId).toBe(3)
    })

    it('binds one-to-one fields and falls back to defaults', async () => {
      await seed()
      await Profile.create({ userId: 1, bio: 'Mathematician' })
      const users = await User.with('profileBio', 'profileOrDefault').order('id').select()
      expect(users[0].toJSON()).toMatchObject({ bio: 'Mathematician' })
      expect(users[0].toJSON().profileBio).toBeUndefined()
      expect(users[1].getRelation('profileOrDefault')!.bio).toBe('none')
      expect((await users[2].profileOrDefault())!.bio).toBe('none')
      expect(await users[2].profile()).toBeNull()
    })

    it('handles many-to-many with pivot data, attach, detach and sync', async () => {
      await seed()
      await Db.table(tags).insert([
        { name: 'orm' },
        { name: 'sql' },
        { name: 'http' },
      ])
      const post = await Post.findOrFail(1)
      await post.tags().attach([1, 2], { weight: 5 })
      await post.tags().attach({
        3: { weight: 9 },
      })
      const loaded = await post.tags()
      expect(loaded.map(tag => [tag.name, (tag.getRelation('pivot' as never) as unknown as { weight: number }).weight])).toEqual([
        ['orm', 5],
        ['sql', 5],
        ['http', 9],
      ])

      expect(await post.tags().detach(2)).toBe(1)
      const result = await post.tags().sync({
        1: { weight: 1 },
        2: {},
      })
      expect(result.attached).toEqual([2])
      expect(result.detached).toEqual([3])
      expect(result.updated).toEqual([1])

      const posts = await Post.with('tags').withCount('tags').order('id').select()
      expect(posts[0].getRelation('tags')!.map(tag => tag.name)).toEqual(['orm', 'sql'])
      expect(posts[0].getAttr('tagsCount')).toBe(2)
      expect(posts[1].getRelation('tags')).toEqual([])
      expect(names(await Tag.has('posts').order('id').select())).toEqual(['orm', 'sql'])
      expect((await (await Tag.findOrFail(1)).posts()).map(item => item.title)).toEqual(['First'])

      const created = await post.tags().save({ name: 'new' }, { weight: 2 })
      expect(created.id).toBe(4)
      expect(await post.tags().query().count()).toBe(3)
    })

    it('loads has-many-through and has-one-through relations', async () => {
      await seed()
      await Comment.create({ postId: 2, body: 'nice' })
      await Comment.create({ postId: 3, body: 'great' })
      await Comment.create({ postId: 4, body: 'bob' })
      const ada = await User.findOrFail(1)
      expect((await ada.comments()).map(comment => comment.body)).toEqual(['nice', 'great'])
      expect((await ada.firstComment())?.body).toBe('nice')
      const users = await User.with('comments').withCount('comments').order('id').select()
      expect(users.map(user => user.getRelation('comments')!.length)).toEqual([2, 1, 0])
      expect(users.map(user => user.getAttr('commentsCount'))).toEqual([2, 1, 0])
      expect(names(await User.has('comments', '>=', 2).select())).toEqual(['Ada'])
    })

    it('handles polymorphic relations', async () => {
      await seed()
      const ada = await User.findOrFail(1)
      const post = await Post.findOrFail(2)
      await ada.avatar().save({ url: 'ada.png' })
      await post.images().save({ url: 'p1.png' })
      await post.images().create({ url: 'p2.png' })
      expect((await ada.avatar())?.url).toBe('ada.png')
      expect((await post.images()).map(image => image.url)).toEqual(['p1.png', 'p2.png'])

      const images = await Image.with('imageable').order('id').select()
      expect(images.map(image => image.getRelation('imageable')!.constructor.name)).toEqual(['User', 'Post', 'Post'])
      expect((await images[0].imageable())!.getKey()).toBe(1)

      const loose = await Image.create({ url: 'loose.png' })
      expect(await loose.imageable()).toBeNull()
      await loose.imageable().associate(ada)
      expect([loose.imageableType, loose.imageableId]).toEqual(['User', 1])

      const posts = await Post.withCount('images').order('id').select()
      expect(posts.map(item => item.getAttr('imagesCount'))).toEqual([0, 2, 0, 0])
      expect(names(await User.has('avatar').select())).toEqual(['Ada'])
    })
  })
})
