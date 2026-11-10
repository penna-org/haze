import { sql } from 'drizzle-orm'
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { DatabaseManager, Db, Model, ModelNotFoundException, setDatabaseManager } from '../src'
import { queryHash } from '../src/query/builder'

// 评审加固项的回归用例（SQLite 内存库）

const categories = sqliteTable('categories', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  parentId: integer('parent_id'),
  name: text('name').notNull(),
})

const accounts = sqliteTable('accounts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  role: text('role').notNull().default('user'),
  lockVersion: integer('lock_version').notNull().default(0),
  meta: text('meta', { mode: 'json' }).$type<{ city?: string, tags?: string[] }>(),
  labels: text('labels', { mode: 'json' }).$type<string[]>(),
  deletedAt: integer('deleted_at', { mode: 'timestamp' }),
})

const countries = sqliteTable('countries', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
})

const members = sqliteTable('members', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  countryId: integer('country_id').notNull(),
  name: text('name').notNull(),
  deletedAt: integer('deleted_at', { mode: 'timestamp' }),
})

const stories = sqliteTable('stories', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  memberId: integer('member_id').notNull(),
  title: text('title').notNull(),
})

const friendships = sqliteTable('friendships', {
  memberId: integer('member_id').notNull(),
  friendId: integer('friend_id').notNull(),
})

const ddl = [
  'create table categories (id integer primary key autoincrement, parent_id integer, name text not null)',
  `create table accounts (id integer primary key autoincrement, name text not null, role text not null default 'user', lock_version integer not null default 0, meta text, labels text, deleted_at integer)`,
  'create table countries (id integer primary key autoincrement, name text not null)',
  'create table members (id integer primary key autoincrement, country_id integer not null, name text not null, deleted_at integer)',
  'create table stories (id integer primary key autoincrement, member_id integer not null, title text not null)',
  'create table friendships (member_id integer not null, friend_id integer not null)',
]

class Category extends Model.define(categories) {
  parent() {
    return this.belongsTo(Category, 'parentId')
  }

  children() {
    return this.hasMany(Category, 'parentId')
  }

  /** 孙分类：中间模型与关联模型都是自己 */
  grandchildren() {
    return this.hasManyThrough(Category, Category, 'parentId', 'parentId')
  }
}

class Account extends Model.define(accounts) {
  static override softDelete = true
  static override optimLock = true
}

class StrictAccount extends Model.define(accounts) {
  static override fillable = ['name', 'role', 'meta']
  static override guarded = ['role']
}

class Country extends Model.define(countries) {
  stories() {
    return this.hasManyThrough(Story, Member, 'countryId', 'memberId')
  }

  latestStory() {
    return this.hasOneThrough(Story, Member, 'countryId', 'memberId')
  }
}

class Member extends Model.define(members) {
  static override softDelete = true

  friends() {
    return this.belongsToMany(Member, friendships, 'friendId', 'memberId')
  }
}

class Story extends Model.define(stories) {}

let manager: DatabaseManager

beforeEach(async () => {
  await manager?.close()
  manager = new DatabaseManager({
    default: 'main',
    connections: {
      main: { driver: 'sqlite', url: ':memory:' },
    },
  })
  setDatabaseManager(manager)
  for (const statement of ddl)
    await Db.execute(sql.raw(statement))
})

afterAll(async () => {
  await manager?.close()
})

describe('mass assignment', () => {
  it('ignores the soft-delete and lock version columns, and the primary key of an existing record', async () => {
    // 新建时可以指定主键；软删除列与版本列来自用户输入时被忽略
    const account = await Account.create({
      id: 10,
      name: 'Ada',
      deletedAt: new Date(),
      lockVersion: 99,
    })
    expect(account.id).toBe(10)
    expect(account.trashed()).toBe(false)
    expect(account.lockVersion).toBe(0)

    const other = await Account.create({ name: 'Bob' })
    // 已存在的记录：主键不接受批量赋值，不会改写主键或把更新指向另一行
    await account.save({
      id: other.id,
      name: 'Ada 2',
      deletedAt: new Date(),
      lockVersion: 50,
    } as never)
    expect(account.id).toBe(10)
    expect(account.trashed()).toBe(false)
    expect(account.lockVersion).toBe(1)
    expect(await Db.table(accounts).order('id').column('name')).toEqual(['Ada 2', 'Bob'])
    expect(await Db.table(accounts).where('id', 10).value('deletedAt')).toBeNull()

    account.fill({
      id: 77,
      deletedAt: new Date(),
    })
    expect(account.id).toBe(10)
    expect(account.isDirty()).toBe(false)
  })

  it('lets allowField(), forceFill() and property assignment opt out', async () => {
    const when = new Date(1_700_000_000_000)
    const imported = await Account.create({ name: 'Imported', lockVersion: 7, deletedAt: when }, ['name', 'lockVersion', 'deletedAt'])
    expect(imported.lockVersion).toBe(7)
    expect(imported.trashed()).toBe(true)

    const forced = new Account().forceFill({ name: 'Forced', lockVersion: 3, unknown: 1 })
    await forced.save()
    expect(forced.lockVersion).toBe(3)
    expect(forced.getData()).not.toHaveProperty('unknown')

    // 显式给属性赋值不受限制（包括主键）
    const account = await Account.create({ name: 'Ada' })
    const original = account.id
    account.id = 500
    await account.save()
    expect(await Db.table(accounts).where('id', original).count()).toBe(0)
    expect(await Db.table(accounts).where('id', 500).value('name')).toBe('Ada')

    account.forceFill({ id: 501 })
    expect(account.id).toBe(501)
  })

  it('honours static fillable / guarded, which allowField() overrides', async () => {
    const strict = await StrictAccount.create({
      name: 'Ada',
      role: 'admin',
      meta: { city: 'Paris' },
      labels: ['x'],
    })
    expect(strict.role).toBe('user')
    expect(strict.meta).toEqual({ city: 'Paris' })
    expect(strict.labels).toBeNull()

    await strict.save({
      role: 'admin',
      labels: ['y'],
      name: 'Ada 2',
    })
    expect(strict.role).toBe('user')
    expect(strict.labels).toBeNull()
    expect(strict.name).toBe('Ada 2')

    const admin = await StrictAccount.create({
      name: 'Root',
      role: 'admin',
      labels: ['z'],
    }, ['name', 'role', 'labels'])
    expect(admin.role).toBe('admin')
    expect(admin.labels).toEqual(['z'])
  })
})

describe('find() with a missing key', () => {
  it('returns undefined for undefined / null instead of the first row', async () => {
    await Account.create({ name: 'Ada' })
    expect(await Account.find(undefined)).toBeUndefined()
    expect(await Account.find(null)).toBeUndefined()
    expect(await Account.query().find(undefined)).toBeUndefined()
    expect(await Account.where('name', 'Ada').find(null)).toBeUndefined()
    await expect(Account.findOrFail(undefined)).rejects.toBeInstanceOf(ModelNotFoundException)
    await expect(Account.query().findOrFail(null)).rejects.toBeInstanceOf(ModelNotFoundException)
    expect((await Account.findOrEmpty(undefined)).isEmpty()).toBe(true)

    // 不传参数：文档约定的“取第一条”
    expect((await Account.query().find())?.name).toBe('Ada')
    expect((await Account.query().findOrFail()).name).toBe('Ada')
    expect((await Account.query().findOrEmpty()).name).toBe('Ada')
    expect((await Account.find(1))?.name).toBe('Ada')
  })
})

describe('self-referential relation existence', () => {
  async function seedTree() {
    // root ─ a ─ a1
    //      └ b          lonely
    const root = await Category.create({ name: 'root' })
    const a = await Category.create({ name: 'a', parentId: root.id })
    await Category.create({ name: 'b', parentId: root.id })
    await Category.create({ name: 'a1', parentId: a.id })
    await Category.create({ name: 'lonely' })
  }

  const names = (query: { column: (key: 'name') => Promise<string[]> }) => query.column('name')

  it('correlates has() / hasNot() / hasWhere() with the outer row', async () => {
    await seedTree()
    expect(await names(Category.has('children').order('id'))).toEqual(['root', 'a'])
    expect(await names(Category.query().hasNot('children').order('id'))).toEqual(['b', 'a1', 'lonely'])
    expect(await names(Category.has('children', '>=', 2).order('id'))).toEqual(['root'])
    expect(await names(Category.has('children', '=', 1).order('id'))).toEqual(['a'])
    expect(await names(Category.has('parent').order('id'))).toEqual(['a', 'b', 'a1'])
    expect(await names(Category.hasWhere('parent', { name: 'root' }).order('id'))).toEqual(['a', 'b'])
    expect(await names(Category.hasWhere('children', (q: any) => q.where('name', 'a1')).order('id'))).toEqual(['a'])
    expect(await names(Category.query().hasNot('children', { name: 'b' }).order('id'))).toEqual(['a', 'b', 'a1', 'lonely'])

    const { sql: text } = await Category.has('children').toSQL()
    expect(text).toContain('"categories_rel"."parent_id" = "categories"."id"')
  })

  it('handles nesting, an aliased outer query and through / many-to-many self relations', async () => {
    await seedTree()
    // 有“自己也有子分类”的子分类
    expect(await names(Category.hasWhere('children', (q: any) => q.has('children')).order('id'))).toEqual(['root'])
    expect(await names(Category.query().alias('c').has('children').order('id'))).toEqual(['root', 'a'])
    expect(await names(Category.has('grandchildren').order('id'))).toEqual(['root'])

    const [ada, bob, cleo] = [
      await Member.create({ countryId: 1, name: 'Ada' }),
      await Member.create({ countryId: 1, name: 'Bob' }),
      await Member.create({ countryId: 1, name: 'Cleo' }),
    ]
    await ada.friends().attach([bob.id])
    expect(await Member.has('friends').column('name')).toEqual(['Ada'])
    expect(await Member.query().hasNot('friends').order('id').column('name')).toEqual(['Bob', 'Cleo'])
    expect(cleo.id).toBe(3)
  })
})

describe('cursor(), chunk(), chunkById() and paginate()', () => {
  async function seedAccounts(count: number) {
    await Db.table(accounts).insert(Array.from({ length: count }, (_, index) => ({ name: `user-${String(index + 1).padStart(2, '0')}` })))
  }

  it('finishes a keyset cursor when the selection has no primary key', async () => {
    await seedAccounts(7)
    const seen: string[] = []
    let guard = 0
    for await (const row of Db.table(accounts).field('name').cursor(3)) {
      seen.push(row.name)
      if (++guard > 50)
        throw new Error('cursor() does not terminate')
    }
    expect(seen).toEqual(Array.from({ length: 7 }, (_, index) => `user-0${index + 1}`))

    const models: string[] = []
    for await (const account of Account.query().field('name').cursor(2))
      models.push(account.name)
    expect(models).toHaveLength(7)

    const partial: number[] = []
    for await (const row of Db.table(accounts).withoutField('id', 'meta').cursor(3))
      partial.push((row as unknown as { id: number }).id)
    expect(partial).toEqual([1, 2, 3, 4, 5, 6, 7])

    // 结果里的 id 是别的表达式：退回 offset 分批，同样能结束
    const aliased: unknown[] = []
    for await (const row of Db.table(accounts).field({ id: accounts.name }).cursor(3))
      aliased.push(row.id)
    expect(aliased).toHaveLength(7)
  })

  it('orders chunk() by primary key by default and keeps an explicit order', async () => {
    await seedAccounts(5)
    expect((await Db.table(accounts).toSQL()).sql).not.toContain('order by')
    const pages: number[][] = []
    await Db.table(accounts).chunk(2, rows => void pages.push(rows.map(row => row.id)))
    expect(pages).toEqual([
      [1, 2],
      [3, 4],
      [5],
    ])

    const reversed: number[][] = []
    await Db.table(accounts).order('id', 'desc').chunk(2, rows => void reversed.push(rows.map(row => row.id)))
    expect(reversed).toEqual([
      [5, 4],
      [3, 2],
      [1],
    ])
  })

  it('walks every row with chunkById() even when rows are deleted on the way', async () => {
    await seedAccounts(7)
    const seen: number[] = []
    const pages: number[] = []
    await Db.table(accounts).order('name', 'desc').chunkById(3, async (rows, page) => {
      pages.push(page)
      seen.push(...rows.map(row => row.id))
      // offset 分页在这里会跳过后面的行
      await Db.table(accounts).whereIn('id', rows.map(row => row.id)).delete()
    })
    expect(seen).toEqual([1, 2, 3, 4, 5, 6, 7])
    expect(pages).toEqual([1, 2, 3])

    await seedAccounts(4)
    const stopped: string[] = []
    await Account.query().field('name').chunkById(2, (rows) => {
      stopped.push(...rows.map(row => row.name))
      return false
    })
    expect(stopped).toHaveLength(2)
    await expect(Db.table(accounts).group('role').chunkById(2, () => {})).rejects.toThrow(/chunkById\(\) needs "id"/)
  })

  it('clamps paginate() arguments to at least 1', async () => {
    await seedAccounts(3)
    const zero = await Db.table(accounts).order('id').paginate(0, 0)
    expect(zero).toMatchObject({
      page: 1,
      perPage: 1,
      total: 3,
      lastPage: 3,
    })
    expect(zero.data).toHaveLength(1)
    const negative = await Account.paginate(-5, -10)
    expect(negative).toMatchObject({ page: 1, perPage: 1, lastPage: 3 })
    const invalid = await Account.paginate(Number.NaN, Number.NaN)
    expect(invalid).toMatchObject({ page: 1, perPage: 15, lastPage: 1 })
    expect((await Db.table(accounts).paginateX(0)).data).toHaveLength(1)
  })
})

describe('query cache key', () => {
  it('uses a 64-bit digest that does not collide on a few hundred thousand keys', () => {
    expect(queryHash('select 1')).toBe(queryHash('select 1'))
    expect(queryHash('select 1')).not.toBe(queryHash('select 2'))
    // 32 位摘要在 30 万个键上几乎必然碰撞（期望约 10 次）
    const seen = new Set<string>()
    for (let index = 0; index < 300_000; index++)
      seen.add(queryHash(`{"sql":"select * from users where id = ?","params":[${index}]}`).slice(0, 14))
    expect(seen.size).toBe(300_000)
  })
})

describe('json columns', () => {
  it('detects in-place changes as dirty', async () => {
    const created = await Account.create({
      name: 'Ada',
      meta: {
        city: 'London',
        tags: ['a'],
      },
      labels: ['x'],
    })
    const account = await Account.findOrFail(created.id)
    expect(account.isDirty()).toBe(false)

    account.meta!.city = 'Paris'
    account.meta!.tags!.push('b')
    account.labels!.push('y')
    expect(account.isDirty('meta')).toBe(true)
    expect(account.isDirty('labels')).toBe(true)
    expect(account.isDirty('name')).toBe(false)
    expect((account.getOriginal('meta') as { city: string }).city).toBe('London')
    await account.save()
    expect(account.isDirty()).toBe(false)

    const reloaded = await Account.findOrFail(created.id)
    expect(reloaded.meta).toEqual({
      city: 'Paris',
      tags: ['a', 'b'],
    })
    expect(reloaded.labels).toEqual(['x', 'y'])

    // 刚创建的模型继续原地修改
    created.meta!.city = 'Rome'
    expect(created.isDirty('meta')).toBe(true)
    // 内容相同的新对象不算修改
    reloaded.meta = {
      city: 'Paris',
      tags: ['a', 'b'],
    }
    expect(reloaded.isDirty()).toBe(false)
  })
})

describe('through relations', () => {
  it('skips soft-deleted intermediate records', async () => {
    const country = await Country.create({ name: 'UK' })
    const ada = await Member.create({ countryId: country.id, name: 'Ada' })
    const bob = await Member.create({ countryId: country.id, name: 'Bob' })
    await Story.create({ memberId: ada.id, title: 'kept' })
    await Story.create({ memberId: bob.id, title: 'hidden' })
    await bob.delete()

    expect((await country.stories()).map(story => story.title)).toEqual(['kept'])
    expect((await country.stories().query().select()).map((story: Story) => story.title)).toEqual(['kept'])
    const [loaded] = await Country.with('stories').withCount('stories').select()
    expect(loaded.getRelation('stories')?.map(story => story.title)).toEqual(['kept'])
    expect(loaded.getData()).toMatchObject({ storiesCount: 1 })

    await ada.delete()
    expect(await country.latestStory()).toBeNull()
    expect(await Country.has('stories').count()).toBe(0)
    await ada.restore()
    expect(await Country.has('stories').count()).toBe(1)
  })
})

describe('eager loading groups', () => {
  it('groups a large child set under the right parents', async () => {
    const root = await Category.create({ name: 'root' })
    const other = await Category.create({ name: 'other' })
    await Db.table(categories).insert(Array.from({ length: 3000 }, (_, index) => ({
      name: `child-${index}`,
      parentId: index % 3 === 0
        ? other.id
        : root.id,
    })))
    const [first, second] = await Category.with('children').whereIn('id', [root.id, other.id]).order('id').select()
    expect(first.getRelation('children')).toHaveLength(2000)
    expect(second.getRelation('children')).toHaveLength(1000)
    expect(second.getRelation('children')!.every(child => child.parentId === other.id)).toBe(true)
  })
})
