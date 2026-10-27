import type { HttpContext } from '../src'
import { describe, expect, it } from 'vitest'
import { createApplication, defineRoutes, Router } from '../src'

class UserController {
  index(): string[] {
    return []
  }

  show(ctx: HttpContext): string | undefined {
    return ctx.param('id')
  }

  store(): object {
    return {}
  }

  update(): object {
    return {}
  }
}

describe('route builder', () => {
  it('joins group prefixes, middleware and name prefixes', () => {
    const router = new Router().load((r) => {
      r.get('/', () => 'home').name('home')
      r.group({
        prefix: '/api',
        middleware: ['api'],
        as: 'api.',
      }, (r) => {
        r.group({
          prefix: 'v1/',
          middleware: ['auth'],
        }, (r) => {
          r.get('users/:id', [UserController, 'show']).name('users.show').middleware('log')
        })
      })
    })

    expect(router.definitions().map(d => [d.method, d.path, d.name, d.middleware])).toEqual([
      ['GET', '/', 'home', []],
      [
        'GET',
        '/api/v1/users/:id',
        'api.users.show',
        ['api', 'auth', 'log'],
      ],
    ])
  })

  it('registers only existing resource actions by default', () => {
    const router = new Router().load(r => r.resource('/users', UserController))
    expect(router.definitions().map(d => `${d.method} ${d.path} ${d.name ?? ''}`.trim())).toEqual([
      'GET /users users.index',
      'POST /users users.store',
      'GET /users/:id users.show',
      'PUT /users/:id users.update',
      'PATCH /users/:id',
    ])
  })

  it('supports only / except / custom param on resources', () => {
    const router = new Router().load((r) => {
      r.resource('/posts', UserController, {
        only: ['index', 'show'],
        except: ['index'],
        param: 'postId',
      })
    })
    expect(router.definitions().map(d => d.path)).toEqual(['/posts/:postId'])
    expect(() => new Router().load(r => r.resource('/x', UserController, {
      only: ['destroy'],
    })))
      .toThrow(/missing methods: destroy/)
  })

  it('validates handlers at definition time', () => {
    expect(() => new Router().load(r => r.get('/', [UserController, 'nope' as 'show'])))
      .toThrow(/UserController.nope is not a method/)
  })

  it('generates urls for named routes', () => {
    const router = new Router().load(r => r.resource('/users', UserController))
    expect(router.url('users.show', { id: 42 }, { tab: 'profile' })).toBe('/users/42?tab=profile')
    expect(() => router.url('users.show')).toThrow(/Missing param "id"/)
    expect(() => router.url('nope')).toThrow(/not defined/)
  })

  it('lists compiled routes with resolved middleware', async () => {
    const log = (): void => {}
    const app = await createApplication({
      mode: 'test',
      env: false,
      config: {
        middleware: {
          alias: { log },
          groups: {
            api: ['log'],
          },
        },
      },
      routes: [
        defineRoutes(r => r.group({
          middleware: ['api'],
        }, r => r.get('/users/:id', [UserController, 'show']))),
      ],
    })
    expect(app.router.list()).toEqual([
      {
        method: 'GET',
        path: '/users/:id',
        name: undefined,
        handler: 'UserController@show',
        middleware: ['log'],
      },
    ])
  })

  it('fails to boot on unknown middleware or duplicate names', async () => {
    await expect(createApplication({
      mode: 'test',
      env: false,
      routes: [
        defineRoutes(r => r.get('/', () => 'x').middleware('ghost')),
      ],
    })).rejects.toThrow(/Unknown middleware "ghost"/)

    await expect(createApplication({
      mode: 'test',
      env: false,
      routes: [
        defineRoutes((r) => {
          r.get('/a', () => 'a').name('dup')
          r.get('/b', () => 'b').name('dup')
        }),
      ],
    })).rejects.toThrow(/Duplicate route name "dup"/)
  })
})
