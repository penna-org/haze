import type { FactoryAttributes } from '../src'
import type { Schema } from './schemas'
import { sql } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest'
import { DatabaseManager, Db, defineFactory, Model, setDatabaseManager } from '../src'
import { dialects } from './schemas'

function defineModels(schema: Schema) {
  class User extends Model.define(schema.users) {
    posts() {
      return this.hasMany(Post, 'userId')
    }

    profile() {
      return this.hasOne(Profile, 'userId')
    }

    avatar() {
      return this.morphOne(Image, 'imageable')
    }
  }

  class Post extends Model.define(schema.posts) {
    user() {
      return this.belongsTo(User, 'userId')
    }

    author() {
      return this.belongsTo(User, 'userId')
    }

    tags() {
      return this.belongsToMany(Tag, schema.postTag, 'tagId', 'postId')
    }

    images() {
      return this.morphMany(Image, 'imageable')
    }
  }

  class Tag extends Model.define(schema.tags) {}

  class Profile extends Model.define(schema.profiles) {}

  class Image extends Model.define(schema.images) {
    imageable() {
      return this.morphTo('imageable', { User, Post })
    }
  }

  const UserFactory = defineFactory(User, ({ faker, sequence }) => ({
    name: faker.person.fullName(),
    email: sequence(n => `user${n}@example.com`),
    age: faker.number.int({ min: 18, max: 80 }),
  }))
    .state('inactive', { status: 0 })
    .state('adult', attributes => ({
      age: Math.max(attributes.age ?? 0, 30),
    }))

  // 外键默认由另一个工厂创建（for() / has() / 覆盖值提供时不会创建）
  const PostFactory = defineFactory(Post, ({ sequence }) => ({
    userId: UserFactory,
    title: sequence(n => `Post ${n}`),
  }))

  const TagFactory = defineFactory(Tag, ({ sequence }) => ({
    name: sequence('red', 'green', 'blue'),
  }))

  const ProfileFactory = defineFactory(Profile, () => ({ bio: 'hello' }))

  const ImageFactory = defineFactory(Image, ({ n }) => ({ url: `/images/${n}.png` }))

  return {
    User,
    Post,
    Tag,
    Profile,
    Image,
    UserFactory,
    PostFactory,
    TagFactory,
    ProfileFactory,
    ImageFactory,
  }
}

// 工厂只依赖模型与事务：SQLite / PGlite / MySQL（与 Turso）上验证
const factoryDialects = dialects.filter(dialect => dialect.connection.driver !== 'd1')

describe.each(factoryDialects)('model factories on $name', (dialect) => {
  const { User, Post, Image, UserFactory, PostFactory, TagFactory, ProfileFactory, ImageFactory } = defineModels(dialect.schema)
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
    await manager.close()
    for (const statement of dialect.ddl)
      await Db.execute(sql.raw(statement))
  })

  afterAll(async () => {
    await manager.close()
    await dialect.dispose?.()
  })

  it('makes models without saving them, with overrides', async () => {
    const user = await UserFactory.make()
    expect(user.exists).toBe(false)
    expect(user.name).toEqual(expect.any(String))
    expect(user.email).toMatch(/^user\d+@example\.com$/)
    expect(await User.count()).toBe(0)

    const ada = await UserFactory.make({ name: 'Ada' })
    expect(ada.name).toBe('Ada')
    // 序号跨调用递增
    expect(Number(ada.email!.match(/\d+/)![0])).toBeGreaterThan(Number(user.email!.match(/\d+/)![0]))

    const many = await UserFactory.count(3).make()
    expect(many).toHaveLength(3)
    expect(new Set(many.map(item => item.email)).size).toBe(3)
  })

  it('creates models, counts and many', async () => {
    const user = await UserFactory.create({ name: 'Ada' })
    expect(user.exists).toBe(true)
    expect(user.id).toEqual(expect.any(Number))
    expect((await User.findOrFail(user.id)).name).toBe('Ada')

    const three = await UserFactory.count(3).create()
    expect(three.every(item => item.exists)).toBe(true)
    const listed = await UserFactory.createMany([
      { name: 'A' },
      { name: 'B' },
    ])
    expect(listed.map(item => item.name)).toEqual(['A', 'B'])
    expect(await UserFactory.createMany(2)).toHaveLength(2)
    expect(await User.count()).toBe(8)
    expect(await UserFactory.makeMany(2)).toHaveLength(2)
    expect(await User.count()).toBe(8)
  })

  it('returns raw attributes', async () => {
    const attributes = await UserFactory.raw({ name: 'Ada' })
    expect(attributes).toMatchObject({
      name: 'Ada',
      email: expect.stringMatching(/@example\.com$/),
    })
    expect(attributes).not.toBeInstanceOf(User)
    expect(await UserFactory.count(2).raw()).toHaveLength(2)
    expect(await User.count()).toBe(0)
  })

  it('applies named and inline states and sequences', async () => {
    expect((await UserFactory.state('inactive').create()).status).toBe(0)
    expect((await UserFactory.create()).status).toBe(1)
    expect((await UserFactory.state('adult').make({ age: 20 })).age).toBe(20)
    expect((await UserFactory.state({ age: 10 }).state('adult').make()).age).toBe(30)
    expect((await UserFactory.state((_attributes, ctx) => ({ name: `#${ctx.index}` })).count(2).make()).map(user => user.name)).toEqual(['#0', '#1'])
    expect(() => UserFactory.state('nope' as never)).toThrow('no state "nope"')

    const users = await UserFactory.count(4).sequence({ status: 1 }, { status: 2 }).create()
    expect(users.map(user => user.status)).toEqual([1, 2, 1, 2])
    const named = await UserFactory.count(2).sequence(ctx => ({ name: `user ${ctx.index}` })).make()
    expect(named.map(user => user.name)).toEqual(['user 0', 'user 1'])
    // 原工厂不受链式调用影响
    expect((await UserFactory.make()).status).toBeUndefined()
  })

  it('runs afterMake before saving and afterCreate after', async () => {
    const events: string[] = []
    const factory = UserFactory
      .afterMake(user => events.push(`make:${user.exists}`))
      .afterCreate(async (user) => {
        events.push(`create:${user.exists}:${await User.count()}`)
      })
    await factory.make()
    await factory.create()
    expect(events).toEqual(['make:false', 'make:false', 'create:true:1'])
  })

  it.skipIf(dialect.connection.driver === 'd1')('creates several models in one transaction', async () => {
    let created = 0
    const failing = UserFactory.afterCreate(() => {
      if (++created === 3)
        throw new Error('boom')
    })
    await expect(failing.count(3).create()).rejects.toThrow('boom')
    expect(await User.count()).toBe(0)
  })

  it('creates a belongsTo parent with for()', async () => {
    const posts = await PostFactory.count(3).for(UserFactory.state({ name: 'Owner' })).create()
    // 同一次调用只创建一个父模型
    expect(await User.count()).toBe(1)
    const owner = await User.where('name', 'Owner').findOrFail()
    expect(posts.map(post => post.userId)).toEqual([owner.id, owner.id, owner.id])

    // 已存在的模型，显式关联名
    const ada = await UserFactory.create({ name: 'Ada' })
    const post = await PostFactory.for(ada, 'author').create()
    expect(post.userId).toBe(ada.id)
    expect((await post.author())?.name).toBe('Ada')
    await expect(PostFactory.for(ada, 'tags').make()).rejects.toThrow('not a belongsTo / morphTo relation')
  })

  it('creates children with has()', async () => {
    const user = await UserFactory.has(PostFactory.count(3), 'posts').create()
    expect(await user.posts()).toHaveLength(3)
    // 关联名默认为子模型的复数
    const [first, second] = await UserFactory.count(2).has(PostFactory.count(2)).create()
    expect(await first.posts()).toHaveLength(2)
    expect(await second.posts()).toHaveLength(2)
    expect(await Post.count()).toBe(7)

    const withProfile = await UserFactory.has(ProfileFactory, 'profile').create()
    expect((await withProfile.profile())?.bio).toBe('hello')
    // make() 不创建子模型
    await UserFactory.has(PostFactory.count(5), 'posts').make()
    expect(await Post.count()).toBe(7)
  })

  it('attaches many-to-many models with pivot data', async () => {
    const post = await PostFactory.hasAttached(TagFactory.count(2), 'tags', { weight: 5 }).create()
    const tags = await post.tags()
    expect(tags).toHaveLength(2)
    expect(tags.map(tag => (tag.getRelation('pivot' as never) as unknown as { weight: number }).weight)).toEqual([5, 5])

    // 已有模型 + 按模型计算的中间表数据
    const existing = await TagFactory.count(2).create()
    const other = await PostFactory.hasAttached(existing, 'tags', tag => ({ weight: tag.id * 10 })).create()
    expect((await other.tags()).map(tag => (tag.getRelation('pivot' as never) as unknown as { weight: number }).weight).sort((a, b) => a - b)).toEqual(existing.map(tag => tag.id * 10).sort((a, b) => a - b))
    // has() 也可用于多对多（不带中间表数据）
    const plain = await PostFactory.has(TagFactory, 'tags').create()
    expect(await plain.tags()).toHaveLength(1)
  })

  it('fills morph types and ids', async () => {
    const post = await PostFactory.for(UserFactory).has(ImageFactory.count(2), 'images').create()
    const images = await post.images()
    expect(images.map(image => [image.imageableType, image.imageableId])).toEqual([
      ['Post', post.id],
      ['Post', post.id],
    ])

    const user = await UserFactory.has(ImageFactory, 'avatar').create()
    expect((await user.avatar())?.imageableType).toBe('User')

    const image = await ImageFactory.for(user, 'imageable').create()
    expect([image.imageableType, image.imageableId]).toEqual(['User', user.id])
    expect(await (await Image.findOrFail(image.id)).imageable()).toBeInstanceOf(User)
  })

  it('resolves factory and function attribute values', async () => {
    const post = await PostFactory.create({
      userId: UserFactory.state({ name: 'Lazy' }),
      title: attributes => `by ${String(attributes.userId)}`,
    })
    const user = await User.where('name', 'Lazy').findOrFail()
    expect([post.userId, post.title]).toEqual([user.id, `by ${user.id}`])
  })
})

describe('factory faker', () => {
  const { UserFactory, User } = defineModels(dialects[0].schema)

  afterEach(() => {
    setDatabaseManager(undefined)
  })

  it('uses the locale from config/database.ts and .locale()', async () => {
    setDatabaseManager(new DatabaseManager({
      default: 'main',
      connections: {
        main: { driver: 'sqlite', url: ':memory:' },
      },
      factories: { locale: 'zh_CN' },
    }))
    const names = (await UserFactory.count(5).make()).map(user => user.name!)
    expect(names.every(name => /\p{Script=Han}/u.test(name))).toBe(true)
    const english = (await UserFactory.locale('en').count(5).make()).map(user => user.name!)
    expect(english.every(name => /^[\x20-\x7E]+$/.test(name))).toBe(true)
    // zh-CN 写法同样可用
    expect((await UserFactory.locale('zh-CN').make()).name).toMatch(/\p{Script=Han}/u)
    await expect(UserFactory.locale('xx_YY').make()).rejects.toThrow('Unknown faker locale "xx_YY"')
    expect(User.name).toBe('User')
  })

  it('throws a clear error from ctx.faker when @faker-js/faker is not installed', async () => {
    vi.resetModules()
    vi.doMock('@faker-js/faker', () => {
      throw new Error('Cannot find package \'@faker-js/faker\'')
    })
    try {
      const { defineFactory: define } = await import('../src/factory')
      const WithFaker = define(User, ({ faker }) => ({
        name: faker.person.fullName(),
      }))
      await expect(WithFaker.make()).rejects.toThrow('pnpm add -D @faker-js/faker')
      // 不使用 faker 的工厂照常工作（sequence 等不依赖 faker）
      const Plain = define(User, ({ sequence }) => ({
        name: sequence(n => `user ${n}`),
      }))
      expect((await Plain.count(2).make()).map(user => user.name)).toEqual(['user 1', 'user 2'])
    }
    finally {
      vi.doUnmock('@faker-js/faker')
      vi.resetModules()
    }
  })
})

// 类型：属性来自模型表的插入类型，状态名受约束（只做类型检查，不执行）
export function factoryTypes(): void {
  const { User, UserFactory, PostFactory } = defineModels(dialects[0].schema)
  type UserModel = InstanceType<typeof User>
  void (async () => {
    expectTypeOf(await UserFactory.make()).toEqualTypeOf<UserModel>()
    expectTypeOf(await UserFactory.count(2).create()).toEqualTypeOf<UserModel[]>()
    expectTypeOf(await UserFactory.createMany(2)).toEqualTypeOf<UserModel[]>()
    expectTypeOf(await UserFactory.raw()).toEqualTypeOf<FactoryAttributes<UserModel>>()
    expectTypeOf(await UserFactory.state('inactive').count(2).raw()).toEqualTypeOf<Array<FactoryAttributes<UserModel>>>()
    expectTypeOf((await UserFactory.raw()).name).toEqualTypeOf<string | undefined>()
    expectTypeOf(await PostFactory.for(UserFactory).make()).toEqualTypeOf<InstanceType<ReturnType<typeof defineModels>['Post']>>()

    // @ts-expect-error 未定义的状态
    UserFactory.state('admin')
    // @ts-expect-error 属性类型不符
    await UserFactory.make({ name: 1 })
    // @ts-expect-error 不存在的列
    await UserFactory.make({ nope: 1 })
    // @ts-expect-error 不存在的关联
    PostFactory.for(UserFactory, 'owner')
    // @ts-expect-error 定义中的属性类型不符
    defineFactory(User, () => ({ age: 'old' }))
    // @ts-expect-error 状态的属性类型不符
    UserFactory.state('broken', { status: 'x' })
  })()
}
