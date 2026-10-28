import type { RawValue } from '../src'
import type { SchemaInput, Serialize } from '../src/client'
import * as v from 'valibot'
import { describe, expect, expectTypeOf, it } from 'vitest'
import { ClientError, createClient } from '../src/client'

const IdParams = v.object({
  id: v.pipe(v.string(), v.transform(Number)),
})

class Post {
  constructor(readonly id: number, readonly createdAt: Date) {}

  toJSON() {
    return {
      id: this.id,
      createdAt: this.createdAt.toISOString(),
    }
  }
}

/** 与 haze typegen 生成的结构一致 */
interface Routes {
  'posts.index': { method: 'GET', path: '/api/posts', params: never, query: { page?: number, tags?: string[] }, output: Promise<Post[]> }
  'posts.show': { method: 'GET', path: '/api/posts/:id', params: SchemaInput<typeof IdParams>, output: { post: Post, load: () => void } }
  'posts.store': { method: 'POST', path: '/api/posts', params: never, body: { title: string }, output: RawValue<{ ok: true }> }
  'files.show': { method: 'GET', path: '/files/**:path', params: { path: string | number }, output: unknown }
}

const routes = {
  'posts.index': { method: 'GET', path: '/api/posts' },
  'posts.show': { method: 'GET', path: '/api/posts/:id' },
  'posts.store': { method: 'POST', path: '/api/posts' },
  'files.show': { method: 'GET', path: '/files/**:path' },
  'legacy': { method: 'GET', path: '/legacy', envelope: false },
} as const

interface Call {
  url: string
  init: RequestInit
}

function mockFetch(respond: (call: Call) => Response = () => Response.json({
  code: 0,
  message: 'ok',
  data: { ok: true },
})) {
  const calls: Call[] = []
  const fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    return respond({ url, init })
  }) as typeof globalThis.fetch
  return { calls, fetch }
}

describe('createClient', () => {
  it('builds URLs from params and query and unwraps the envelope', async () => {
    const { calls, fetch } = mockFetch(() => Response.json({
      code: 0,
      message: 'ok',
      data: [
        { id: 1 },
      ],
    }))
    const api = createClient<Routes>({ routes, baseURL: 'https://api.test/', fetch })

    const posts = await api('posts.index', {
      query: {
        page: 2,
        tags: ['a', 'b'],
      },
    })
    expect(posts).toEqual([
      { id: 1 },
    ])
    expect(calls[0].url).toBe('https://api.test/api/posts?page=2&tags=a&tags=b')
    expect(calls[0].init.method).toBe('GET')
    expect(calls[0].init.body).toBeUndefined()

    await api('posts.show', {
      params: { id: 'a b' },
    })
    expect(calls[1].url).toBe('https://api.test/api/posts/a%20b')
    expect(api.url('files.show', {
      params: { path: 'x' },
    })).toBe('https://api.test/files/x')
  })

  it('sends JSON bodies with default and per-request headers', async () => {
    const { calls, fetch } = mockFetch()
    const api = createClient<Routes>({
      routes,
      fetch,
      headers: async () => ({ authorization: 'Bearer t' }),
    })

    expect(await api('posts.store', {
      body: { title: 'Hi' },
      headers: { 'x-trace': '1' },
    })).toEqual({ ok: true })
    const headers = new Headers(calls[0].init.headers)
    expect(calls[0].url).toBe('/api/posts')
    expect(calls[0].init.method).toBe('POST')
    expect(calls[0].init.body).toBe('{"title":"Hi"}')
    expect(headers.get('content-type')).toBe('application/json')
    expect(headers.get('authorization')).toBe('Bearer t')
    expect(headers.get('x-trace')).toBe('1')
    expect(calls[0].init.credentials).toBe('same-origin')
  })

  it('converts bodies with files to multipart form data', async () => {
    const { calls, fetch } = mockFetch()
    const api = createClient({ routes, fetch })
    await api('posts.store', {
      body: {
        title: 'Hi',
        avatar: new File(['x'], 'a.png'),
      },
    })
    const body = calls[0].init.body as FormData
    expect(body).toBeInstanceOf(FormData)
    expect(body.get('title')).toBe('Hi')
    expect((body.get('avatar') as File).name).toBe('a.png')
    expect(new Headers(calls[0].init.headers).has('content-type')).toBe(false)
  })

  it('keeps raw responses for envelope: false routes and supports custom unwrap', async () => {
    const { fetch } = mockFetch(() => Response.json({ code: 0, data: 1 }))
    expect(await createClient({ routes, fetch })('legacy')).toEqual({ code: 0, data: 1 })
    expect(await createClient({ routes, fetch, envelope: false })('posts.index')).toEqual({ code: 0, data: 1 })
    expect(await createClient({
      routes,
      fetch,
      unwrap: body => (body as { data: number }).data + 1,
    })('posts.index')).toBe(2)

    const text = mockFetch(() => new Response('hello', {
      headers: { 'content-type': 'text/plain' },
    }))
    expect(await createClient({ routes, fetch: text.fetch })('posts.index')).toBe('hello')
    const empty = mockFetch(() => new Response(null, { status: 204 }))
    expect(await createClient({ routes, fetch: empty.fetch })('posts.index')).toBeUndefined()
  })

  it('throws ClientError with validation errors on failure', async () => {
    const { fetch } = mockFetch(() => Response.json({
      code: 422,
      message: 'Validation Failed',
      data: null,
      errors: [
        { target: 'body', path: 'title', message: 'Required' },
      ],
    }, { status: 422 }))
    const api = createClient<Routes>({ routes, fetch })
    const error = await api('posts.store', {
      body: { title: '' },
    }).catch(error => error)
    expect(error).toBeInstanceOf(ClientError)
    expect(error).toMatchObject({ status: 422, code: 422, message: 'Validation Failed' })
    expect(error.errors).toEqual([
      { target: 'body', path: 'title', message: 'Required' },
    ])
  })

  it('rejects unknown routes and missing params', async () => {
    const { fetch } = mockFetch()
    const api = createClient({ routes, fetch })
    await expect(api('nope')).rejects.toThrow('Route "nope" is not defined')
    await expect(api('posts.show')).rejects.toThrow('Missing param "id" for route "posts.show"')
  })

  it('infers inputs and serialized outputs', () => {
    // 客户端发送的是 schema 的输入类型（transform 之前）
    expect(v.parse(IdParams, { id: '1' })).toEqual({ id: 1 })
    const api = createClient<Routes>({ routes })
    expectTypeOf(api<'posts.index'>).returns.resolves.toEqualTypeOf<Array<{ id: number, createdAt: string }>>()
    expectTypeOf(api<'posts.show'>).returns.resolves.toEqualTypeOf<{ post: { id: number, createdAt: string } }>()
    expectTypeOf(api<'posts.store'>).returns.resolves.toEqualTypeOf<{ ok: true }>()
    expectTypeOf(api<'posts.show'>).parameter(1).toHaveProperty('params').toEqualTypeOf<{ id: string }>()
    expectTypeOf(api<'posts.index'>).parameter(1).exclude<undefined>().toHaveProperty('query').toEqualTypeOf<{ page?: number, tags?: string[] } | undefined>()
    expectTypeOf<Serialize<Date>>().toEqualTypeOf<string>()
    expectTypeOf<Serialize<{ a?: number, b: string | undefined, c: Date | null }>>().toEqualTypeOf<{ a?: number, b: string, c: string | null }>()

    // @ts-expect-error params 必填
    void (() => api('posts.show'))
    void (() => api('posts.store', {
      // @ts-expect-error body 类型不符
      body: { title: 1 },
    }))
    // @ts-expect-error 未知路由
    void (() => api('nope'))
  })
})
