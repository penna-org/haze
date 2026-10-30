import type { ApplicationOptions, MiddlewareHandler, RouteRegistrar } from '../src'
import type { OpenAPIConfig } from '../src/openapi'
import { H3 } from 'h3'
import * as v from 'valibot'
import { describe, expect, it } from 'vitest'
import { createApplication, defineRoutes, Router } from '../src'
import { generateOpenAPI, openAPIMiddleware, renderDocsPage, SCALAR_VERSION, SWAGGER_UI_VERSION, toJSONSchema, toOpenAPIPath } from '../src/openapi'

class PostController {
  index() {
    return []
  }

  show() {
    return {}
  }

  store() {
    return {}
  }

  update() {
    return {}
  }

  destroy() {
    return null
  }
}

function boot(routes: RouteRegistrar, options: ApplicationOptions & { mode?: 'test' | 'production' | 'development' } = {}) {
  return createApplication({
    mode: 'test',
    env: false,
    ...options,
    config: {
      logger: { level: 'silent' },
      ...options.config,
    },
    routes: [
      defineRoutes(routes),
    ],
  })
}

const PostSchema = v.object({
  id: v.number(),
  title: v.string(),
})

const authConfig = {
  auth: {
    default: 'api',
    guards: {
      api: { driver: 'jwt', provider: 'users' },
      web: { driver: 'session', provider: 'users' },
    },
    providers: {},
  },
}

async function documentOf(routes: RouteRegistrar, options: ApplicationOptions = {}, overrides: OpenAPIConfig = {}) {
  const app = await boot(routes, options)
  return generateOpenAPI(app, overrides)
}

describe('openapi paths', () => {
  it('converts route paths to OpenAPI templates', () => {
    expect(toOpenAPIPath('/users/:id/posts/:post')).toEqual({
      path: '/users/{id}/posts/{post}',
      params: ['id', 'post'],
    })
    expect(toOpenAPIPath('/files/**:path')).toEqual({
      path: '/files/{path}',
      params: ['path'],
    })
    expect(toOpenAPIPath('/')).toEqual({ path: '/', params: [] })
  })

  it('documents every route with operationId, tags and path parameters', async () => {
    const doc = await documentOf((r) => {
      r.group({ prefix: '/api', as: 'api.' }, (r) => {
        r.resource('/posts', PostController)
        r.get('/health', () => ({ ok: true }))
      })
      r.ws('/ws', {})
    }, {
      config: {
        app: { name: 'Blog' },
      },
    })

    expect(doc.openapi).toBe('3.1.0')
    expect(doc.info).toEqual({ title: 'Blog', version: '1.0.0' })
    expect(Object.keys(doc.paths)).toEqual(['/api/posts', '/api/posts/{id}', '/api/health'])
    expect(Object.keys(doc.paths['/api/posts/{id}'])).toEqual(['get', 'put', 'patch', 'delete'])

    const show = doc.paths['/api/posts/{id}'].get
    expect(show.operationId).toBe('api.posts.show')
    expect(show.tags).toEqual(['posts'])
    expect(show.parameters).toEqual([
      {
        name: 'id',
        in: 'path',
        required: true,
        schema: { type: 'string' },
      },
    ])
    // 未命名的 PATCH（资源 update 的别名）由方法与路径生成
    expect(doc.paths['/api/posts/{id}'].patch.operationId).toBe('patchApiPostsById')
    expect(doc.paths['/api/health'].get.operationId).toBe('getApiHealth')
    expect(doc.tags).toEqual([
      { name: 'posts' },
      { name: 'health' },
    ])
  })
})

describe('openapi request schemas', () => {
  it('reads params, query, headers and body from .validate()', async () => {
    const doc = await documentOf((r) => {
      r.get('/posts', () => []).validate({
        query: v.object({
          q: v.optional(v.pipe(v.string(), v.description('Search text'))),
          page: v.pipe(v.string(), v.transform(Number)),
        }),
        headers: v.object({
          'x-tenant': v.string(),
        }),
      })
      r.put('/posts/:id', () => ({})).validate({
        params: v.object({
          id: v.pipe(v.string(), v.regex(/^\d+$/)),
        }),
        body: v.object({
          title: v.pipe(v.string(), v.minLength(1)),
          tags: v.optional(v.array(v.string())),
        }),
      })
    })

    const index = doc.paths['/posts'].get
    expect(index.parameters).toEqual([
      {
        name: 'q',
        in: 'query',
        required: false,
        description: 'Search text',
        schema: { type: 'string' },
      },
      // 输入类型：transform 之前的 string
      {
        name: 'page',
        in: 'query',
        required: true,
        schema: { type: 'string' },
      },
      {
        name: 'x-tenant',
        in: 'header',
        required: true,
        schema: { type: 'string' },
      },
    ])
    expect(index.requestBody).toBeUndefined()

    const update = doc.paths['/posts/{id}'].put
    expect(update.parameters).toEqual([
      {
        name: 'id',
        in: 'path',
        required: true,
        schema: { type: 'string', pattern: '^\\d+$' },
      },
    ])
    expect(update.requestBody).toEqual({
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              title: { type: 'string', minLength: 1 },
              tags: {
                type: 'array',
                items: { type: 'string' },
              },
            },
            required: ['title'],
          },
        },
      },
    })
  })

  it('uses multipart/form-data when the body has file fields', async () => {
    const doc = await documentOf(r => r.post('/avatar', () => ({})).validate({
      body: v.object({
        avatar: v.pipe(v.file(), v.maxSize(1024)),
        caption: v.optional(v.string()),
      }),
    }))
    const content = doc.paths['/avatar'].post.requestBody!.content
    expect(Object.keys(content)).toEqual(['multipart/form-data'])
    expect(content['multipart/form-data'].schema.properties.avatar).toEqual({ type: 'string', format: 'binary' })
  })

  it('accepts Standard JSON Schema libraries and plain JSON Schema', async () => {
    const standard = {
      '~standard': {
        version: 1,
        vendor: 'custom',
        validate: (value: unknown) => ({ value }),
        jsonSchema: {
          input: () => ({
            $schema: 'https://json-schema.org/draft/2020-12/schema',
            type: 'object',
            properties: {
              name: { type: 'string' },
            },
          }),
        },
      },
    }
    expect(await toJSONSchema(standard as never)).toEqual({
      type: 'object',
      properties: {
        name: { type: 'string' },
      },
    })
    expect(await toJSONSchema({ type: 'integer' })).toEqual({ type: 'integer' })
    // 无法转换时不抛错
    expect(await toJSONSchema({
      '~standard': {
        version: 1,
        vendor: 'other',
        validate: () => ({ value: 1 }),
      },
    } as never)).toBeUndefined()
  })
})

describe('openapi responses', () => {
  it('wraps success responses in the envelope and adds 422 for validated routes', async () => {
    const doc = await documentOf((r) => {
      r.post('/posts', () => ({})).validate({
        body: v.object({
          title: v.string(),
        }),
      }).doc({ response: PostSchema, status: 201 })
    })
    const operation = doc.paths['/posts'].post
    expect(operation.responses['201'].content['application/json'].schema).toEqual({
      type: 'object',
      properties: {
        code: { type: 'integer', const: 0 },
        message: {
          type: 'string',
          examples: ['ok'],
        },
        data: {
          type: 'object',
          properties: {
            id: { type: 'number' },
            title: { type: 'string' },
          },
          required: ['id', 'title'],
        },
      },
      required: ['code', 'message', 'data'],
    })
    expect(operation.responses['422']).toEqual({ $ref: '#/components/responses/ValidationError' })
    expect(doc.components.responses.ValidationError.content['application/json'].schema).toEqual({ $ref: '#/components/schemas/ValidationError' })
    expect(doc.components.schemas.Error.properties).toHaveProperty('code')
    expect(doc.components.schemas.ValidationError.allOf[1].properties.errors.type).toBe('array')
  })

  it('skips the envelope for envelope: false routes and when disabled globally', async () => {
    const doc = await documentOf((r) => {
      r.get('/raw', () => ({})).meta({ envelope: false }).doc({ response: PostSchema })
      r.get('/wrapped', () => ({})).doc({ response: PostSchema })
    })
    expect(doc.paths['/raw'].get.responses['200'].content['application/json'].schema.properties).toHaveProperty('title')
    expect(doc.paths['/wrapped'].get.responses['200'].content['application/json'].schema.properties).toHaveProperty('code')

    const plain = await documentOf(r => r.get('/x', () => ({})).doc({ response: PostSchema }), {
      config: {
        app: {
          response: { envelope: false },
        },
      },
    })
    expect(plain.paths['/x'].get.responses['200'].content['application/json'].schema.properties).toHaveProperty('title')
  })

  it('uses a custom envelope function for custom formatters', async () => {
    const doc = await documentOf(r => r.get('/x', () => ({})), {}, {
      envelope: data => ({
        type: 'object',
        properties: {
          success: { type: 'boolean' },
          result: data,
        },
      }),
    })
    expect(doc.paths['/x'].get.responses['200'].content['application/json'].schema.properties).toHaveProperty('success')
  })

  it('adds 401 and security for auth routes, 403 for can / guest', async () => {
    const doc = await documentOf((r) => {
      r.get('/me', () => ({})).middleware('auth')
      r.get('/both', () => ({})).middleware('auth:api,web')
      r.put('/posts/:id', () => ({})).middleware('auth', 'can:update')
      r.post('/register', () => ({})).middleware('guest')
      r.get('/public', () => ({}))
      // 直接传入、恰好与别名同名的函数不是那个中间件
      const guest: MiddlewareHandler = (_ctx, next) => next()
      r.get('/inline', () => ({})).middleware(guest)
    }, { config: authConfig })

    expect(doc.components.securitySchemes).toEqual({
      api: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      web: { type: 'apiKey', in: 'cookie', name: 'haze_session' },
    })
    expect(doc.paths['/me'].get.security).toEqual([
      { api: [] },
    ])
    expect(doc.paths['/me'].get.responses['401']).toEqual({ $ref: '#/components/responses/Unauthorized' })
    expect(doc.paths['/both'].get.security).toEqual([
      { api: [] },
      { web: [] },
    ])
    expect(doc.paths['/posts/{id}'].put.responses).toHaveProperty('403')
    expect(doc.paths['/register'].post.responses).toHaveProperty('403')
    expect(doc.paths['/register'].post.responses).not.toHaveProperty('401')
    expect(doc.paths['/inline'].get.responses).not.toHaveProperty('403')
    expect(doc.paths['/public'].get.security).toBeUndefined()
    expect(doc.paths['/public'].get.responses).toEqual({
      200: expect.objectContaining({ description: 'Successful response' }),
    })
  })

  it('falls back to a generic bearer scheme without config/auth.ts', async () => {
    const doc = await documentOf(r => r.get('/me', () => ({})).middleware('auth'))
    expect(doc.components.securitySchemes).toEqual({
      bearerAuth: { type: 'http', scheme: 'bearer' },
    })
    expect(doc.paths['/me'].get.security).toEqual([
      { bearerAuth: [] },
    ])
  })
})

describe('route .doc()', () => {
  it('sets summary, description, tags, deprecated, operationId and extra responses', async () => {
    const doc = await documentOf((r) => {
      r.get('/posts/:id', () => ({})).name('posts.show').doc({
        summary: 'Show a post',
        description: 'Returns one post',
        tags: ['Blog'],
        deprecated: true,
        operationId: 'getPost',
        responses: {
          404: { description: 'Post not found' },
        },
        extensions: {
          'x-permission': ['post:view'],
          'x-rate-limit': { max: 5 },
        },
      })
      r.delete('/posts/:id', () => null).doc({ status: 204, security: [] }).middleware('auth')
    }, {}, {
      tags: [
        { name: 'Blog', description: 'Blog posts' },
      ],
    })

    const show = doc.paths['/posts/{id}'].get
    expect(show).toMatchObject({
      'operationId': 'getPost',
      'summary': 'Show a post',
      'description': 'Returns one post',
      'tags': ['Blog'],
      'deprecated': true,
      'x-permission': ['post:view'],
      'x-rate-limit': { max: 5 },
    })
    expect(show.responses['404']).toEqual({ description: 'Post not found' })
    expect(doc.paths['/posts/{id}'].delete.responses['204']).toEqual({ description: 'No content' })
    expect(doc.paths['/posts/{id}'].delete.security).toEqual([])
    expect(doc.tags).toEqual([
      { name: 'Blog', description: 'Blog posts' },
      { name: 'posts' },
    ])
  })

  it('hides routes with hidden: true and applies resource-level docs', async () => {
    const doc = await documentOf((r) => {
      r.get('/internal', () => ({})).doc({ hidden: true })
      r.resource('/posts', PostController, {
        only: ['index', 'show'],
      }).doc({
        tags: ['Posts'],
      })
    })
    expect(doc.paths).not.toHaveProperty('/internal')
    expect(doc.paths['/posts'].get.tags).toEqual(['Posts'])
    expect(doc.paths['/posts/{id}'].get.tags).toEqual(['Posts'])
  })

  it('reads info and servers from config and supports include filters', async () => {
    const doc = await documentOf((r) => {
      r.get('/a', () => ({}))
      r.get('/b', () => ({}))
    }, {
      config: {
        app: { name: 'Shop', url: 'https://shop.test' },
        openapi: {
          info: { version: '2.1.0', description: 'Shop API' },
        },
      },
    }, {
      include: route => route.path !== '/b',
    })
    expect(doc.info).toEqual({ title: 'Shop', version: '2.1.0', description: 'Shop API' })
    expect(doc.servers).toEqual([
      { url: 'https://shop.test' },
    ])
    expect(Object.keys(doc.paths)).toEqual(['/a'])
  })

  it('includes routes of mounted apps with their prefix', async () => {
    const doc = await documentOf(r => r.get('/home', () => ({})), {
      config: {
        app: {
          apps: {
            admin: { prefix: '/admin' },
          },
        },
      },
      apps: {
        '/app/admin/route/web.ts': {
          default: defineRoutes(r => r.get('/users/:id', () => ({})).name('users.show')),
        },
      },
    })
    expect(Object.keys(doc.paths)).toEqual(['/home', '/admin/users/{id}'])
    expect(doc.paths['/admin/users/{id}'].get).toMatchObject({
      operationId: 'admin.users.show',
      tags: ['admin'],
    })
  })

  it('works with a bare Router', async () => {
    const app = await boot(r => r.get('/a', () => ({})).name('a'))
    expect(app.router).toBeInstanceOf(Router)
    const doc = await generateOpenAPI(app.router)
    expect(doc.info.title).toBe('API')
    expect(doc.paths['/a'].get.operationId).toBe('a')
  })
})

describe('openAPIMiddleware', () => {
  async function serve(options: ApplicationOptions & { mode?: 'test' | 'production' } = {}) {
    const app = await boot(r => r.get('/posts', () => []).name('posts.index'), options)
    const h3 = new H3()
    h3.use(openAPIMiddleware(app))
    h3.get('/**', () => 'fallthrough')
    return h3
  }

  it('serves the JSON document and the Scalar docs page', async () => {
    const h3 = await serve({
      config: {
        app: { name: 'Blog <API>' },
      },
    })
    const res = await h3.request('/openapi.json')
    expect(res.headers.get('content-type')).toContain('application/json')
    const doc = await res.json() as any
    expect(doc.paths['/posts'].get.operationId).toBe('posts.index')

    const page = await h3.request('/docs')
    expect(page.headers.get('content-type')).toContain('text/html')
    const html = await page.text()
    expect(html).toContain(`@scalar/api-reference@${SCALAR_VERSION}/`)
    expect(html).toContain('"url":"/openapi.json"')
    expect(html).toContain('<title>Blog &lt;API&gt;</title>')
    expect(await (await h3.request('/other')).text()).toBe('fallthrough')
  })

  it('supports custom paths and Swagger UI', async () => {
    const h3 = await serve({
      config: {
        openapi: { path: '/api/openapi.json', docsPath: '/api/docs', ui: 'swagger' },
      },
    })
    expect((await h3.request('/api/openapi.json')).status).toBe(200)
    const html = await (await h3.request('/api/docs')).text()
    expect(html).toContain(`swagger-ui-dist@${SWAGGER_UI_VERSION}/swagger-ui-bundle.js`)
    expect(html).toContain('"url":"/api/openapi.json"')
    expect(await (await h3.request('/openapi.json')).text()).toBe('fallthrough')
  })

  it('is disabled in production unless enabled explicitly', async () => {
    const production = await serve({ mode: 'production' })
    expect(await (await production.request('/openapi.json')).text()).toBe('fallthrough')
    expect(await (await production.request('/docs')).text()).toBe('fallthrough')

    const enabled = await serve({
      mode: 'production',
      config: {
        openapi: { enabled: true, docsPath: false },
      },
    })
    expect((await enabled.request('/openapi.json')).status).toBe(200)
    expect(await (await enabled.request('/docs')).text()).toBe('fallthrough')
  })

  it('escapes the embedded configuration', () => {
    const html = renderDocsPage({
      url: '/x',
      title: 't',
      uiOptions: { note: '</script><script>alert(1)</script>' },
    })
    expect(html).not.toContain('</script><script>alert(1)')
  })
})
