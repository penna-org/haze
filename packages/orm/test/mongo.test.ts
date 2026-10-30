import type { ObjectId } from 'mongodb'
import type { MongoModelQuery } from '../src/mongo'
import { createApplication, defineRoutes } from '@hazejs/core'
import { MongoMemoryReplSet } from 'mongodb-memory-server-core'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { DatabaseManager, databaseProvider, ModelNotFoundException, refreshDatabase, setDatabaseManager, UniqueConstraintException } from '../src'
import { Mongo, MongoModel } from '../src/mongo'

interface UserDoc {
  name: string
  email?: string | null
  status: number
  age?: number | null
  createdAt?: Date
  updatedAt?: Date
  deletedAt?: Date | null
}

interface PostDoc {
  userId: ObjectId
  title: string
  views: number
}

interface ProfileDoc {
  userId: ObjectId
  bio: string
}

const events: string[] = []

class User extends MongoModel.define<UserDoc>('users') {
  static override softDelete = true
  static override hidden = ['email']
  static override append = ['label']

  getLabelAttr() {
    return `${this.name}#${String(this.id).slice(-4)}`
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

  static scopeAdults(query: MongoModelQuery<User>, min = 18) {
    query.where('age', '>=', min)
  }

  onBeforeInsert() {
    events.push(`beforeInsert:${this.name}`)
  }

  onAfterUpdate() {
    events.push(`afterUpdate:${this.name}`)
  }
}

class Post extends MongoModel.define<PostDoc>('posts') {
  author() {
    return this.belongsTo(User, 'userId')
  }
}

class Profile extends MongoModel.define<ProfileDoc>('profiles') {}

let replSet: MongoMemoryReplSet
let manager: DatabaseManager
function connection() {
  return {
    driver: 'mongodb' as const,
    url: replSet.getUri(),
    database: 'haze_test',
  }
}

beforeAll(async () => {
  // 单节点副本集：支持事务；首次运行会下载 mongod 二进制
  replSet = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: 'wiredTiger' },
  })
  manager = new DatabaseManager({
    default: 'mongo',
    connections: {
      mongo: connection(),
    },
  })
  setDatabaseManager(manager)
}, 300_000)

beforeEach(async () => {
  setDatabaseManager(manager)
  await refreshDatabase()
  events.length = 0
})

afterAll(async () => {
  await manager?.close()
  await replSet?.stop()
})

const users = () => Mongo.collection<UserDoc>('users')

async function seed() {
  await users().insert([
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

async function names(query: ReturnType<typeof users>) {
  return (await query.order('name').select()).map(doc => doc.name)
}

describe('mongo query builder', () => {
  it('inserts and returns documents with ids', async () => {
    const docs = await users().insert([
      { name: 'Ada', status: 1 },
      { name: 'Bob', status: 1 },
    ])
    expect(docs.map(doc => doc.name)).toEqual(['Ada', 'Bob'])
    expect(docs[0]._id.toHexString()).toHaveLength(24)
    const id = await users().insertGetId({ name: 'Cleo', status: 1 })
    expect((await users().where('_id', id.toHexString()).find())?.name).toBe('Cleo')
  })

  it('supports the same where variants as SQL plus mongo operators', async () => {
    await seed()
    expect(await names(users().where('status', 1))).toEqual(['Ada', 'Cleo', 'Dan'])
    expect(await names(users().where('age', '>', 20))).toEqual(['Ada', 'Cleo'])
    expect(await names(users().where({ status: 1, email: null }))).toEqual(['Cleo'])
    expect(await names(users().where('name', ['Bob', 'Dan']))).toEqual(['Bob', 'Dan'])
    expect(await names(users().whereNull('age'))).toEqual(['Dan'])
    expect(await names(users().whereBetween('age', [17, 25]))).toEqual(['Bob', 'Cleo'])
    expect(await names(users().whereLike('name', '%n'))).toEqual(['Dan'])
    expect(await names(users().whereLike('name', 'A_a'))).toEqual(['Ada'])
    expect(await names(users().where('status', 0).orWhere(q => q.where('age', '>', 30).whereNotNull('email')))).toEqual(['Ada', 'Bob'])
    expect(await names(users().where({
      age: { $gte: 25, $lt: 40 },
    }))).toEqual(['Ada', 'Cleo'])
  })

  it('orders, limits, projects and aggregates', async () => {
    await seed()
    expect((await users().whereNotNull('age').order('age', 'desc').field('name').select()).map(doc => Object.keys(doc).sort())).toEqual([
      ['_id', 'name'],
      ['_id', 'name'],
      ['_id', 'name'],
    ])
    expect(await users().order('name').page(2, 3).column('name')).toEqual(['Dan'])
    expect(await users().where('name', 'Bob').value('age')).toBe(17)
    expect(await users().count()).toBe(4)
    expect(await users().sum('age')).toBe(78)
    expect(await users().avg('age')).toBe(26)
    expect(await users().max('age')).toBe(36)
    expect(await users().min('age')).toBe(17)
    expect(await users().where('name', 'Zed').exists()).toBe(false)
    await expect(users().where('name', 'Zed').findOrFail()).rejects.toBeInstanceOf(ModelNotFoundException)

    const page = await users().order('name').paginate(2, 3)
    expect({
      ...page,
      data: page.data.map(doc => doc.name),
    }).toEqual({
      data: ['Dan'],
      total: 4,
      page: 2,
      perPage: 3,
      lastPage: 2,
    })
  })

  it('runs aggregation pipelines scoped by the current conditions', async () => {
    await seed()
    const result = await users().where('status', 1).aggregate<{ _id: null, adults: number }>([
      {
        $group: {
          _id: null,
          adults: {
            $sum: {
              $cond: [
                {
                  $gte: ['$age', 18],
                },
                1,
                0,
              ],
            },
          },
        },
      },
    ])
    expect(result).toEqual([
      { _id: null, adults: 2 },
    ])
  })

  it('updates, increments and deletes with counts, refusing unconditional writes', async () => {
    await seed()
    expect(await users().where('status', 1).update({ status: 2 })).toBe(3)
    expect(await users().where('name', 'Ada').increment('status', 3)).toBe(1)
    expect(await users().where('name', 'Ada').value('status')).toBe(5)
    await expect(users().update({ status: 0 })).rejects.toThrow(/without conditions/)
    await expect(users().delete()).rejects.toThrow(/without conditions/)
    expect(await users().where('age', '<', 18).delete()).toBe(1)
    expect(await users().delete({ all: true })).toBe(3)
  })

  it('translates duplicate keys into 409 exceptions', async () => {
    await (await Mongo.db()).collection('users').createIndex({ email: 1 }, { unique: true })
    await User.create({ name: 'Ada', email: 'ada@example.com', status: 1 })
    const error = await User.create({ name: 'Copy', email: 'ada@example.com', status: 1 }).catch(error => error)
    expect(error).toBeInstanceOf(UniqueConstraintException)
    expect(error.status).toBe(409)
    expect(error).toMatchObject({
      code: 'unique_violation',
      constraint: 'email_1',
      table: 'users',
      columns: ['email'],
    })
  })
})

describe('mongo transactions', () => {
  it('commits, rolls back and propagates to models', async () => {
    await Mongo.transaction(async () => {
      await users().insert({ name: 'In tx', status: 1 })
      await User.create({ name: 'Model in tx', status: 1 })
    })
    expect(await users().count()).toBe(2)

    await expect(Mongo.transaction(async () => {
      await User.create({ name: 'Rolled back', status: 1 })
      throw new Error('boom')
    })).rejects.toThrow('boom')
    expect(await User.where('name', 'Rolled back').count()).toBe(0)
  })

  it('reuses the outer transaction for nested calls', async () => {
    await expect(Mongo.transaction(async () => {
      await users().insert({ name: 'outer', status: 1 })
      await Mongo.transaction(async () => {
        await users().insert({ name: 'inner', status: 1 })
      })
      throw new Error('rollback all')
    })).rejects.toThrow('rollback all')
    expect(await users().count()).toBe(0)
  })
})

describe('mongo model', () => {
  it('creates with mutators, timestamps and events, and finds by string id', async () => {
    const user = await User.create({ name: '  Ada  ', age: 36, status: 1 })
    expect(user.exists).toBe(true)
    expect(user.name).toBe('Ada')
    expect(user.createdAt).toBeInstanceOf(Date)
    expect(events).toEqual(['beforeInsert:Ada'])

    const found = await User.findOrFail(user.id!.toHexString())
    expect(found).toBeInstanceOf(User)
    expect(found.name).toBe('Ada')
    await expect(User.findOrFail('000000000000000000000000')).rejects.toThrow('User 000000000000000000000000 不存在')
  })

  it('saves only dirty fields through property assignment', async () => {
    const user = await User.create({ name: 'Ada', age: 30, status: 1 })
    user.age = 31
    expect(user.isDirty('age')).toBe(true)
    expect(user.isDirty('name')).toBe(false)
    await user.save()
    expect(events).toContain('afterUpdate:Ada')
    expect((await User.findOrFail(user.id)).age).toBe(31)
  })

  it('serializes with accessors, hidden fields and string ids', async () => {
    const user = await User.create({ name: 'Ada', email: 'secret@example.com', status: 1 })
    const json = JSON.parse(JSON.stringify(user))
    expect(json._id).toBe(user.id!.toHexString())
    expect(json.label).toBe(`Ada#${user.id!.toHexString().slice(-4)}`)
    expect(json).not.toHaveProperty('email')
  })

  it('soft deletes, restores and force deletes', async () => {
    const ada = await User.create({ name: 'Ada', status: 1 })
    const bob = await User.create({ name: 'Bob', status: 1 })
    await bob.delete()
    expect(bob.trashed()).toBe(true)
    expect((await User.all()).map(user => user.name)).toEqual(['Ada'])
    expect(await User.withTrashed().count()).toBe(2)
    expect((await User.onlyTrashed().select()).map(user => user.name)).toEqual(['Bob'])

    await (await User.onlyTrashed().findOrFail(bob.id)).restore()
    expect(await User.count()).toBe(2)
    await ada.forceDelete()
    expect(await User.withTrashed().count()).toBe(1)
    expect(await User.destroy([bob.id])).toBe(1)
    expect(await User.onlyTrashed().count()).toBe(1)
  })

  it('does not treat the soft-delete filter as a condition for bulk writes', async () => {
    await seed()
    const refused = /Refusing to (update|delete) all documents of "users" without conditions/
    await expect(User.query().update({ status: 9 })).rejects.toThrow(refused)
    await expect(User.query().delete()).rejects.toThrow(refused)
    await expect(User.onlyTrashed().delete()).rejects.toThrow(refused)
    await expect(User.query().forceDelete()).rejects.toThrow(refused)
    await expect(User.query().restore()).rejects.toThrow(refused)
    await expect(User.onlyTrashed().restore()).rejects.toThrow(refused)
    expect(await User.withTrashed().where('status', 9).count()).toBe(0)
    expect(await User.onlyTrashed().count()).toBe(0)

    expect(await User.where('name', 'Ada').update({ status: 2 })).toBe(1)
    expect(await User.query().delete({ all: true })).toBe(4)
    expect(await User.onlyTrashed().where('name', 'Bob').restore()).toBe(1)
    expect(await User.onlyTrashed().forceDelete({ all: true })).toBe(3)
    expect(await User.query().update({ status: 7 }, { all: true })).toBe(1)
    expect(await User.withTrashed().column('name')).toEqual(['Bob'])
  })

  it('applies scopes and paginates models', async () => {
    await seed()
    expect((await User.scope('adults').order('name').select()).map(user => user.name)).toEqual(['Ada', 'Cleo'])
    expect((await User.scope('adults', 30).select()).map(user => user.name)).toEqual(['Ada'])
    const page = await User.where('status', 1).order('name').paginate(1, 2)
    expect(page.total).toBe(3)
    expect(page.data[0]).toBeInstanceOf(User)
  })
})

describe('mongo relations', () => {
  async function seedRelations() {
    const ada = await User.create({ name: 'Ada', status: 1 })
    const bob = await User.create({ name: 'Bob', status: 1 })
    await Post.create({ userId: ada.id!, title: 'Ada 1', views: 0 })
    await Post.create({ userId: ada.id!, title: 'Ada 2', views: 0 })
    await Post.create({ userId: bob.id!, title: 'Bob 1', views: 0 })
    await Profile.create({ userId: ada.id!, bio: 'Mathematician' })
    return { ada, bob }
  }

  it('loads lazily and eagerly with nesting', async () => {
    const { ada, bob } = await seedRelations()
    expect((await ada.posts()).map(post => post.title).sort()).toEqual(['Ada 1', 'Ada 2'])
    expect((await ada.profile())?.bio).toBe('Mathematician')
    expect(await bob.profile()).toBeNull()
    const post = await Post.where('title', 'Bob 1').findOrFail()
    expect((await post.author())?.name).toBe('Bob')
    expect(await ada.posts().query().where('title', 'Ada 2').count()).toBe(1)

    const list = await User.with('posts', 'profile', 'posts.author').order('name').select()
    expect(list[0].getRelation('posts')?.map(item => item.title).sort()).toEqual(['Ada 1', 'Ada 2'])
    expect(list[0].getRelation('profile')?.bio).toBe('Mathematician')
    expect(list[1].getRelation('profile')).toBeNull()
    expect(list[0].getRelation('posts')?.[0].getRelation('author')?.name).toBe('Ada')
    expect(JSON.parse(JSON.stringify(list[1])).posts).toEqual([
      expect.objectContaining({
        title: 'Bob 1',
        userId: bob.id!.toHexString(),
      }),
    ])
  })
})

describe('mongo framework integration', () => {
  it('serves mongo models through the unified response format', async () => {
    const app = await createApplication({
      mode: 'test',
      env: false,
      config: {
        database: {
          default: 'mongo',
          connections: {
            mongo: connection(),
          },
        },
      },
      providers: [
        databaseProvider(),
      ],
      routes: [
        defineRoutes(r => r.get('/users/:id', ctx => User.findOrFail(ctx.param('id')))),
      ],
    })
    const ada = await User.create({ name: 'Ada', status: 1 })
    const ok = await (await app.request(`/users/${ada.id!.toHexString()}`)).json() as any
    expect(ok).toMatchObject({
      code: 0,
      data: {
        _id: ada.id!.toHexString(),
        name: 'Ada',
      },
    })
    const missing = await app.request('/users/000000000000000000000000')
    expect(missing.status).toBe(404)
  })
})
