import type { Application } from '../src'
import { afterAll, describe, expect, expectTypeOf, it } from 'vitest'
import { createApplication, defineRoutes, generateOpenAPI } from '../src'
import { defineResource, merge, when, whenLoaded, whenNotNull } from '../src/http/resource'

/** 模拟 ORM 记录：关联通过 hasRelation / getRelation 读取，序列化用 toJSON */
class Record {
  readonly #relations: { [name: string]: unknown }
  constructor(readonly attrs: { id: number, name: string, email: string, role: string, bio?: string | null }, relations: { [name: string]: unknown } = {}) {
    this.#relations = relations
  }

  get id() {
    return this.attrs.id
  }

  hasRelation(name: string) {
    return name in this.#relations
  }

  getRelation(name: string) {
    return this.#relations[name]
  }

  toJSON() {
    return this.attrs
  }
}

const PostResource = defineResource((post: { id: number, title: string }) => ({
  id: post.id,
  title: post.title.toUpperCase(),
}))

const UserResource = defineResource((user: Record, ctx) => ({
  id: user.id,
  name: user.attrs.name,
  // 只有本人（x-user-id）能看到邮箱
  email: when(ctx.header('x-user-id') === String(user.id), user.attrs.email),
  role: when(user.attrs.role === 'admin', 'admin', 'member'),
  bio: whenNotNull(user.attrs.bio),
  posts: whenLoaded('posts', PostResource),
  // 异步字段
  score: Promise.resolve(user.id * 10),
  ...merge(user.attrs.role === 'admin', () => ({
    permissions: ['*'],
  })),
}), {
  schema: {
    type: 'object',
    properties: {
      id: { type: 'integer' },
      name: { type: 'string' },
    },
  },
})

const ada = new Record({
  id: 1,
  name: 'Ada',
  email: 'ada@example.com',
  role: 'admin',
  bio: 'Math',
}, {
  posts: [
    { id: 7, title: 'notes' },
  ],
})
const bob = new Record({
  id: 2,
  name: 'Bob',
  email: 'bob@example.com',
  role: 'member',
  bio: null,
})

const apps: Application[] = []
afterAll(async () => {
  for (const app of apps)
    await app.dispose()
})

async function boot(register: Parameters<typeof defineRoutes>[0], config: { [key: string]: unknown } = {}) {
  const app = await createApplication({
    mode: 'test',
    env: false,
    config: {
      logger: { level: 'silent' },
      ...config,
    },
    routes: [
      defineRoutes(register),
    ],
  })
  apps.push(app)
  return app
}

describe('resources', () => {
  it('transforms a single item with conditional, async and nested fields', async () => {
    const app = await boot((r) => {
      r.get('/users/:id', ctx => UserResource.make(ctx.param('id') === '1'
        ? ada
        : bob))
      r.get('/missing', () => UserResource.make(null))
    })
    const self = await (await app.request('/users/1', {
      headers: { 'x-user-id': '1' },
    })).json() as any
    expect(self).toEqual({
      code: 0,
      message: 'ok',
      data: {
        id: 1,
        name: 'Ada',
        email: 'ada@example.com',
        role: 'admin',
        bio: 'Math',
        posts: [
          { id: 7, title: 'NOTES' },
        ],
        score: 10,
        permissions: ['*'],
      },
    })
    // 条件不成立的字段被移除，关联未加载时不输出
    const other = await (await app.request('/users/2', {
      headers: { 'x-user-id': '1' },
    })).json() as any
    expect(other.data).toEqual({
      id: 2,
      name: 'Bob',
      role: 'member',
      score: 20,
    })
    expect((await (await app.request('/missing')).json() as any).data).toBeNull()
  })

  it('transforms collections and keeps pagination meta / links', async () => {
    const app = await boot((r) => {
      r.get('/users', () => UserResource.collection([ada, bob]))
      r.get('/paged', ctx => UserResource.collection({
        data: [bob],
        total: 3,
        page: Number(ctx.query('page')),
        perPage: 1,
        lastPage: 3,
      }))
      r.get('/cursor', () => UserResource.collection({
        data: [ada],
        perPage: 1,
        lastId: 1,
        hasMore: true,
      }))
      r.get('/raw', () => UserResource.collection({
        data: [],
        total: 0,
        page: 1,
        perPage: 15,
        lastPage: 1,
      })).meta({ envelope: false })
    })
    const list = await (await app.request('/users')).json() as any
    expect(list.data.map((user: { id: number }) => user.id)).toEqual([1, 2])

    const paged = await (await app.request('/paged?page=2&sort=name')).json() as any
    expect(paged.data).toEqual({
      data: [
        {
          id: 2,
          name: 'Bob',
          role: 'member',
          score: 20,
        },
      ],
      meta: {
        total: 3,
        page: 2,
        perPage: 1,
        lastPage: 3,
        from: 2,
        to: 2,
      },
      links: {
        first: '/paged?page=1&sort=name',
        last: '/paged?page=3&sort=name',
        prev: '/paged?page=1&sort=name',
        next: '/paged?page=3&sort=name',
      },
    })

    const cursor = await (await app.request('/cursor?lastId=9')).json() as any
    expect(cursor.data.meta).toEqual({ perPage: 1, hasMore: true, lastId: 1 })
    expect(cursor.data.links).toEqual({ next: '/cursor?lastId=1' })

    // 关闭统一格式时直接输出 { data, meta, links }
    expect(await (await app.request('/raw')).json() as any).toEqual({
      data: [],
      meta: {
        total: 0,
        page: 1,
        perPage: 15,
        lastPage: 1,
        from: null,
        to: null,
      },
      links: {
        first: '/raw?page=1',
        last: '/raw?page=1',
        prev: null,
        next: null,
      },
    })
  })

  it('adds top-level data with additional()', async () => {
    const app = await boot((r) => {
      r.get('/one', () => UserResource.make(bob).additional({
        version: Promise.resolve(2),
      }))
      r.get('/page', () => UserResource.collection({
        data: [],
        total: 0,
        page: 1,
        perPage: 15,
        lastPage: 1,
      }).additional({
        filters: { role: 'any' },
      }))
    })
    expect((await (await app.request('/one')).json() as any).data).toEqual({
      data: {
        id: 2,
        name: 'Bob',
        role: 'member',
        score: 20,
      },
      version: 2,
    })
    const page = (await (await app.request('/page')).json() as any).data
    expect(Object.keys(page)).toEqual(['data', 'meta', 'links', 'filters'])
  })

  it('works outside requests when ctx is not used, and with explicit whenLoaded(item, relation)', async () => {
    const Plain = defineResource(async (user: Record) => {
      await Promise.resolve()
      return {
        id: user.id,
        posts: whenLoaded(user, 'posts', posts => (posts as unknown[]).length),
      }
    })
    expect(await Plain.make(ada)).toEqual({ id: 1, posts: 1 })
    expect(await Plain.collection([bob])).toEqual([
      { id: 2 },
    ])
    await expect(UserResource.make(ada).resolve()).rejects.toThrow(/outside of a request/)
    const Late = defineResource(async (_user: Record) => {
      await Promise.resolve()
      return {
        posts: whenLoaded('posts'),
      }
    })
    await expect(Late.make(ada)).rejects.toThrow(/synchronously/)
  })

  it('infers output types and documents the schema', async () => {
    type User = Awaited<ReturnType<typeof UserResource.make<Record>>>
    expectTypeOf<User['id']>().toEqualTypeOf<number>()
    expectTypeOf<User['score']>().toEqualTypeOf<number>()
    expectTypeOf<User['email']>().toEqualTypeOf<string | undefined>()
    expectTypeOf<User['role']>().toEqualTypeOf<string>()
    expectTypeOf<User['permissions']>().toEqualTypeOf<string[] | undefined>()
    const _Lazy = defineResource((user: Record) => ({
      n: when(user.id > 0, () => 1),
      later: when(Promise.resolve(true), () => 'x'),
    }))
    type LazyData = Awaited<ReturnType<typeof _Lazy.make<Record>>>
    expectTypeOf<LazyData>().toEqualTypeOf<{ n?: number, later?: string }>()

    const app = await boot(r => r.get('/users/:id', () => UserResource.make(ada)).name('users.show').doc({ response: UserResource.schema }))
    const doc = await generateOpenAPI(app)
    expect(JSON.stringify(doc.paths['/users/{id}'].get)).toContain('"name":{"type":"string"}')
  })
})
