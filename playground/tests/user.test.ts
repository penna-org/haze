import type { Application } from '@think-h3/core'
import { Logger } from '@think-h3/core'
import { beforeEach, describe, expect, it } from 'vitest'
import { UserRepository } from '~/app/repository/UserRepository'
import { ErrorCode } from '~/app/service/UserService'
import { createApp } from '~/bootstrap'

const auth = { authorization: 'Bearer secret-token' }

let app: Application

beforeEach(async () => {
  app = await createApp({
    setup: app => void app.container.instance(Logger, new Logger({ level: 'silent' })),
  })
})

function send(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  return app.request(path, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined
      ? undefined
      : JSON.stringify(body),
  })
}

describe('playground app', () => {
  it('loads config from .env and lists routes on the home page', async () => {
    const body = await (await app.request('/')).json() as any
    expect(body.data.name).toBe('think-h3 playground')
    expect(body.data.routes).toContain('GET /api/users/:id')
  })

  it('exposes the compiled route table', () => {
    expect(app.router.list().map(r => [r.method, r.path, r.name, r.middleware])).toEqual([
      ['GET', '/', 'home', []],
      [
        'GET',
        '/api/me',
        'api.me',
        ['auth'],
      ],
      [
        'GET',
        '/api/users',
        'api.users.index',
        [],
      ],
      [
        'POST',
        '/api/users',
        'api.users.store',
        ['auth'],
      ],
      [
        'GET',
        '/api/users/:id',
        'api.users.show',
        [],
      ],
      [
        'PUT',
        '/api/users/:id',
        'api.users.update',
        ['auth'],
      ],
      [
        'PATCH',
        '/api/users/:id',
        undefined,
        ['auth'],
      ],
      [
        'DELETE',
        '/api/users/:id',
        'api.users.destroy',
        ['auth'],
      ],
    ])
    expect(app.router.url('api.users.show', { id: 1 })).toBe('/api/users/1')
  })

  it('lists and shows users seeded by the provider', async () => {
    const list = await (await app.request('/api/users')).json() as any
    expect(list).toEqual({
      code: 0,
      message: 'ok',
      data: [
        { id: 1, name: 'Admin', email: 'admin@example.com' },
      ],
    })

    const show = await (await app.request('/api/users/1')).json() as any
    expect(show.data.name).toBe('Admin')
  })

  it('validates and converts the :id param', async () => {
    const res = await app.request('/api/users/abc')
    expect(res.status).toBe(422)
    expect((await res.json() as any).errors).toEqual([
      { target: 'params', path: 'id', message: '用户 ID 必须是整数' },
    ])
  })

  it('returns 404 for missing users with the request id header', async () => {
    const res = await app.request('/api/users/99', {
      headers: { 'x-request-id': 'req-1' },
    })
    expect(res.status).toBe(404)
    expect(res.headers.get('x-request-id')).toBe('req-1')
    expect(await res.json() as any).toEqual({ code: 404, message: '用户 99 不存在', data: null })
  })

  it('requires authentication for write actions', async () => {
    const res = await send('POST', '/api/users', { name: 'Bob', email: 'bob@example.com' })
    expect(res.status).toBe(401)
    expect((await res.json() as any).message).toBe('请先登录')
  })

  it('creates, updates and deletes users', async () => {
    const created = await send('POST', '/api/users', { name: '  Bob ', email: 'bob@example.com' }, auth)
    expect(created.status).toBe(201)
    const bob = (await created.json() as any).data
    expect(bob).toEqual({ id: 2, name: 'Bob', email: 'bob@example.com' })

    const updated = await send('PATCH', `/api/users/${bob.id}`, { name: 'Bobby' }, auth)
    expect((await updated.json() as any).data.name).toBe('Bobby')

    const deleted = await send('DELETE', `/api/users/${bob.id}`, undefined, auth)
    expect(deleted.status).toBe(204)
    expect(app.make(UserRepository).find(bob.id)).toBeUndefined()
  })

  it('reports validation and business errors in the unified format', async () => {
    const invalid = await send('POST', '/api/users', { name: 'B', email: 'nope' }, auth)
    expect(invalid.status).toBe(422)
    expect((await invalid.json() as any).errors.map((e: { path: string }) => e.path)).toEqual(['name', 'email'])

    const taken = await send('POST', '/api/users', { name: 'Admin 2', email: 'admin@example.com' }, auth)
    expect(taken.status).toBe(200)
    expect(await taken.json() as any).toEqual({ code: ErrorCode.EmailTaken, message: '邮箱已被注册', data: null })
  })

  it('shares state between middleware and controllers', async () => {
    const res = await app.request('/api/me', { headers: auth })
    expect((await res.json() as any).data).toEqual({ id: 1, name: 'Admin', email: 'admin@example.com' })
  })

  it('isolates state between application instances', async () => {
    await send('POST', '/api/users', { name: 'Carol', email: 'carol@example.com' }, auth)
    const fresh = await createApp()
    expect(fresh.make(UserRepository).all()).toHaveLength(1)
  })
})
