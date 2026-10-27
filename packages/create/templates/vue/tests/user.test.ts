import { refreshDatabase } from '@think-h3/orm'
import { useTestApp } from '@think-h3/testing'
import { beforeEach, describe, expect, it } from 'vitest'

const t = useTestApp()
// .env.test 中 DATABASE_URL=:memory:，每个用例都是执行过迁移的全新数据库
beforeEach(() => refreshDatabase({ migrations: 'server/database/migrations' }))

describe('users', () => {
  it('creates, lists, updates and deletes users', async () => {
    const created = await t.post('/api/users', { name: ' Ada ', email: 'ada@example.com' })
    expect(created.status).toBe(201)
    const ada = created.body.data
    expect(ada).toMatchObject({ name: 'Ada', email: 'ada@example.com' })

    const list = await t.get('/api/users')
    expect(list.body.data).toMatchObject({
      total: 1,
      data: [
        { id: ada.id },
      ],
    })

    const updated = await t.patch(`/api/users/${ada.id}`, { name: 'Ada Lovelace' })
    expect(updated.body.data.name).toBe('Ada Lovelace')

    expect((await t.delete(`/api/users/${ada.id}`)).status).toBe(204)
    expect((await t.get(`/api/users/${ada.id}`)).status).toBe(404)
  })

  it('rejects duplicate emails with 409', async () => {
    await t.post('/api/users', { name: 'Ada', email: 'ada@example.com' })
    const res = await t.post('/api/users', { name: 'Copy', email: 'ada@example.com' })
    expect(res.status).toBe(409)
    expect(res.body.message).toBe('数据已存在（违反唯一约束）')
  })

  it('validates input', async () => {
    const res = await t.post('/api/users', { name: '', email: 'nope' })
    expect(res.status).toBe(422)
    expect(res.body.errors.map((e: { path: string }) => e.path)).toEqual(['name', 'email'])
  })
})
