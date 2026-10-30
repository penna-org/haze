import type { DevServer } from '../src'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createDevServer, generateTypes, jsonSchemaToType } from '../src'
import { copyFixture, settle } from './utils'

let dev: DevServer | undefined
let fixture: ReturnType<typeof copyFixture> | undefined

afterEach(async () => {
  await dev?.close()
  fixture?.cleanup()
  dev = undefined
  fixture = undefined
})

/** 实现 Standard JSON Schema 的最小 schema（fixture 中没有安装 valibot） */
const schemaHelper = `
export function schema<T>(json: Record<string, unknown>) {
  return {
    '~standard': {
      version: 1,
      vendor: 'test',
      validate: (value: unknown) => ({ value: value as T }),
      jsonSchema: { input: () => json, output: () => json },
      types: undefined as unknown as { input: T, output: T },
    },
  }
}
`

describe('route typegen', () => {
  it('emits method, path, inputs and controller output types for named routes', async () => {
    fixture = copyFixture('basic')
    fixture.write('app/validate/schema.ts', schemaHelper)
    fixture.write('app/validate/post.ts', `
import { schema } from './schema'
export const CreatePostSchema = schema<{ title: string }>({ type: 'object', properties: { title: { type: 'string' } }, required: ['title'] })
export default schema<{ id: string }>({ type: 'object', properties: { id: { type: 'string' } }, required: ['id'] })
`)
    fixture.write('app/controller/PostController.ts', `
export class PostController {
  index() {
    return [{ id: 1 }]
  }

  async show() {
    return { id: 1, title: 'Hello' }
  }

  store() {
    return { ok: true }
  }
}
`)
    fixture.write('route/posts.ts', `
import { defineRoutes } from '@hazejs/core'
import { PostController } from '~/app/controller/PostController'
import PostParams, { CreatePostSchema } from '~/app/validate/post'
import { schema } from '~/app/validate/schema'

export default defineRoutes((r) => {
  r.group({ prefix: '/api', as: 'api.' }, (r) => {
    r.get('/posts', [PostController, 'index']).name('posts.index').validate({
      query: schema({ type: 'object', properties: { page: { type: 'integer' }, tags: { type: 'array', items: { type: 'string' } }, sort: { enum: ['new', 'old'] } }, required: ['page'] }),
    })
    r.get('/posts/:id', [PostController, 'show']).name('posts.show').validate({ params: PostParams })
    r.post('/posts', [PostController, 'store']).name('posts.store').validate({ body: CreatePostSchema })
    r.get('/users/:user/avatar', () => new Response('x')).name('users.avatar').meta({ envelope: false })
  })
})
`)
    dev = await createDevServer({ root: fixture.root, listen: false })
    await settle()

    const types = readFileSync(join(fixture.root, '.haze/types/haze.d.ts'), 'utf8')
    expect(types).toContain(`import type { SchemaInput } from '@hazejs/core/client'`)
    expect(types).toContain(`declare module '@hazejs/core/client' {
  interface GeneratedRoutes {`)
    expect(types).toContain(`    "api.posts.index": {
      method: "GET"
      path: "/api/posts"
      params: never
      query: { page: number; tags?: Array<string>; sort?: "new" | "old" }
      output: Awaited<ReturnType<InstanceType<typeof import("../../app/controller/PostController").PostController>["index"]>>
    }`)
    expect(types).toContain(`      params: SchemaInput<typeof import("../../app/validate/post").default>`)
    expect(types).toContain(`      body: SchemaInput<typeof import("../../app/validate/post").CreatePostSchema>`)
    // 闭包处理器无法引用返回类型；未校验的路径参数取自路径
    expect(types).toContain(`    "api.users.avatar": {
      method: "GET"
      path: "/api/users/:user/avatar"
      params: { user: string | number }
      output: unknown
    }`)

    const manifest = readFileSync(join(fixture.root, '.haze/routes.ts'), 'utf8')
    expect(manifest).toContain(`export const routes = {
  "api.posts.index": { method: "GET", path: "/api/posts" },
  "api.posts.show": { method: "GET", path: "/api/posts/:id" },
  "api.posts.store": { method: "POST", path: "/api/posts" },
  "api.users.avatar": { method: "GET", path: "/api/users/:user/avatar", envelope: false },
} as const`)
  })

  it('omits client routes when generating without them', () => {
    const { content } = generateTypes({ root: '/tmp/x', srcDir: '/tmp/x', routes: [] })
    expect(content).not.toContain('@hazejs/core/client')
  })

  it('converts JSON Schema to TypeScript types', () => {
    expect(jsonSchemaToType({
      type: ['string', 'null'],
    })).toBe('string | null')
    expect(jsonSchemaToType({
      type: 'object',
      properties: {
        'a-b': { type: 'string', format: 'binary' },
      },
    })).toBe('{ "a-b"?: Blob }')
    expect(jsonSchemaToType({
      type: 'object',
      additionalProperties: { type: 'number' },
    })).toBe('{ [key: string]: number }')
    expect(jsonSchemaToType({
      type: 'array',
      items: {
        anyOf: [
          { type: 'string' },
          { type: 'number' },
        ],
      },
    })).toBe('Array<string | number>')
    expect(jsonSchemaToType({
      $ref: '#/$defs/Node',
      $defs: {
        Node: {
          type: 'object',
          properties: {
            next: { $ref: '#/$defs/Node' },
          },
        },
      },
    })).toBe('{ next?: unknown }')
    expect(jsonSchemaToType({
      allOf: [
        {
          type: 'object',
          properties: {
            a: { const: 1 },
          },
          required: ['a'],
        },
        { type: 'object' },
      ],
    })).toBe('{ a: 1 } & Record<string, unknown>')
    expect(jsonSchemaToType({})).toBe('unknown')
  })
})

describe('config typegen', () => {
  it('lets config/cache.ts name a Redis connection without a circular type (also in conditional spreads)', async () => {
    const ts = (await import('typescript')).default
    fixture = copyFixture('basic')
    fixture.write('config/redis.ts', `
import { defineRedisConfig } from '@hazejs/core'

export default defineRedisConfig(() => ({
  default: 'default',
  connections: { default: { url: 'redis://127.0.0.1:6379' }, queue: { url: 'redis://127.0.0.1:6380' } },
}))
`)
    const shared = !!globalThis.process
    fixture.write('config/cache.ts', `
import { defineCacheConfig } from '@hazejs/core'

const shared = ${shared}
export default defineCacheConfig({
  default: 'memory',
  stores: {
    memory: { driver: 'memory' },
    redis: { driver: 'redis', connection: 'default' },
    ...(shared ? { locks: { driver: 'redis', connection: 'queue' } } : {}),
  },
})
`)
    fixture.write('app/check.ts', `
import type { RedisConnectionName } from '@hazejs/core'

export const ok: RedisConnectionName = 'queue'
// @ts-expect-error unknown connection
export const wrong: RedisConnectionName = 'missing'
`)
    const { file, content } = generateTypes({ root: fixture.root, srcDir: fixture.root, routes: [] })
    expect(content).toContain('interface GeneratedRedisConnections {')
    fixture.write(join('.haze', 'types', 'haze.d.ts'), content)
    expect(file).toBe(join(fixture.root, '.haze', 'types', 'haze.d.ts'))
    const program = ts.createProgram([
      join(fixture.root, 'config/cache.ts'),
      join(fixture.root, 'config/redis.ts'),
      join(fixture.root, 'app/check.ts'),
      file,
    ], {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      types: [],
    })
    const diagnostics = ts.getPreEmitDiagnostics(program).map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))
    expect(diagnostics).toEqual([])
  })
})
