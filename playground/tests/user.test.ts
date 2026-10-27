import { Logger } from '@think-h3/core'
import { createTestApp, useTestApp } from '@think-h3/testing'
import { describe, expect, it } from 'vitest'
import { UserRepository } from '~/app/repository/UserRepository'
import { ErrorCode } from '~/app/service/UserService'

// 每个用例一个全新的应用实例
const t = useTestApp({
  override: container => void container.instance(Logger, new Logger({ level: 'silent' })),
})
const asAdmin = () => t.withHeaders({ authorization: 'Bearer secret-token' })

describe('playground app', () => {
  it('loads config from .env and lists routes on the home page', async () => {
    const { body } = await t.get('/')
    expect(body.data.name).toBe('think-h3 playground')
    expect(body.data.routes).toContain('GET /api/users/:id')
  })

  it('exposes the compiled route table', () => {
    expect(t.app.router.list().map(r => `${r.method} ${r.path} ${r.name ?? '-'} [${r.middleware}]`)).toEqual([
      'GET / home []',
      'GET /api/me api.me [auth]',
      'GET /api/users api.users.index []',
      'POST /api/users api.users.store [auth]',
      'GET /api/users/:id api.users.show []',
      'PUT /api/users/:id api.users.update [auth]',
      'PATCH /api/users/:id - [auth]',
      'DELETE /api/users/:id api.users.destroy [auth]',
    ])
    expect(t.app.router.url('api.users.show', { id: 1 })).toBe('/api/users/1')
  })

  it('lists and shows users seeded by the provider', async () => {
    expect((await t.get('/api/users')).body).toEqual({
      code: 0,
      message: 'ok',
      data: [
        { id: 1, name: 'Admin', email: 'admin@example.com' },
      ],
    })
    expect((await t.get('/api/users/1')).body.data.name).toBe('Admin')
  })

  it('validates and converts the :id param', async () => {
    const res = await t.get('/api/users/abc')
    expect(res.status).toBe(422)
    expect(res.body.errors).toEqual([
      { target: 'params', path: 'id', message: '用户 ID 必须是整数' },
    ])
  })

  it('returns 404 for missing users with the request id header', async () => {
    const res = await t.get('/api/users/99', {
      headers: { 'x-request-id': 'req-1' },
    })
    expect(res.status).toBe(404)
    expect(res.headers.get('x-request-id')).toBe('req-1')
    expect(res.body).toEqual({ code: 404, message: '用户 99 不存在', data: null })
  })

  it('requires authentication for write actions', async () => {
    const res = await t.post('/api/users', { name: 'Bob', email: 'bob@example.com' })
    expect([res.status, res.body.message]).toEqual([401, '请先登录'])
  })

  it('creates, updates and deletes users', async () => {
    const api = asAdmin()
    const created = await api.post('/api/users', { name: '  Bob ', email: 'bob@example.com' })
    expect(created.status).toBe(201)
    const bob = created.body.data
    expect(bob).toEqual({ id: 2, name: 'Bob', email: 'bob@example.com' })

    expect((await api.patch(`/api/users/${bob.id}`, { name: 'Bobby' })).body.data.name).toBe('Bobby')
    expect((await api.delete(`/api/users/${bob.id}`)).status).toBe(204)
    expect(t.make(UserRepository).find(bob.id)).toBeUndefined()
  })

  it('reports validation and business errors in the unified format', async () => {
    const api = asAdmin()
    const invalid = await api.post('/api/users', { name: 'B', email: 'nope' })
    expect(invalid.status).toBe(422)
    expect(invalid.body.errors.map((e: { path: string }) => e.path)).toEqual(['name', 'email'])

    const taken = await api.post('/api/users', { name: 'Admin 2', email: 'admin@example.com' })
    expect(taken.status).toBe(200)
    expect(taken.body).toEqual({ code: ErrorCode.EmailTaken, message: '邮箱已被注册', data: null })
  })

  it('shares state between middleware and controllers', async () => {
    expect((await asAdmin().get('/api/me')).body.data).toEqual({ id: 1, name: 'Admin', email: 'admin@example.com' })
  })

  it('isolates state between application instances', async () => {
    await asAdmin().post('/api/users', { name: 'Carol', email: 'carol@example.com' })
    const fresh = await createTestApp()
    expect(fresh.make(UserRepository).all()).toHaveLength(1)
    await fresh.close()
  })

  it('replaces bindings with override', async () => {
    class FakeRepository extends UserRepository {
      override all() {
        return [
          { id: 7, name: 'Fake', email: 'fake@example.com' },
        ]
      }
    }
    const app = await createTestApp({
      override: c => void c.instance(UserRepository, new FakeRepository()),
    })
    expect((await app.get('/api/users')).body.data).toEqual([
      { id: 7, name: 'Fake', email: 'fake@example.com' },
    ])
    await app.close()
  })
})
