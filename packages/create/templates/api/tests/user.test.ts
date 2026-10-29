import { refreshDatabase } from '@hazejs/orm'
import { useTestApp } from '@hazejs/testing'
import { beforeEach, describe, expect, it } from 'vitest'
import { User } from '~/app/model/User'
import UserFactory from '~/database/factories/UserFactory'

const t = useTestApp()
// .env.test 中 DATABASE_URL=:memory:，每个用例都是执行过迁移的全新数据库
beforeEach(() => refreshDatabase({ migrations: 'database/migrations' }))

describe('users', () => {
  it('creates, lists, updates and deletes users', async () => {
    const created = await t.post('/api/users', { name: ' Ada ', email: 'ada@example.com' })
    expect(created.status).toBe(201)
    const ada = created.body.data
    expect(ada).toMatchObject({ name: 'Ada', email: 'ada@example.com' })

    // 列表经过 API 资源（app/resource/UserResource.ts）：分页信息在 meta / links，未登录时不输出邮箱
    const list = await t.get('/api/users')
    expect(list.body.data).toMatchObject({
      data: [
        { id: ada.id, name: 'Ada' },
      ],
      meta: { total: 1, page: 1, lastPage: 1 },
      links: { next: null },
    })
    expect(list.body.data.data[0]).not.toHaveProperty('email')

    // 修改 / 删除需要登录且为本人（app/policy/UserPolicy.ts）
    const asAda = await t.actingAs(await User.findOrFail(ada.id))
    const updated = await asAda.patch(`/api/users/${ada.id}`, { name: 'Ada Lovelace' })
    expect(updated.body.data.name).toBe('Ada Lovelace')

    expect((await asAda.delete(`/api/users/${ada.id}`)).status).toBe(204)
    expect((await t.get(`/api/users/${ada.id}`)).status).toBe(404)
  })

  it('only lets users change themselves, unless they are admins', async () => {
    // 模型工厂（database/factories/UserFactory.ts）生成测试数据
    const [ada, bob] = await UserFactory.createMany([
      { name: 'Ada' },
      { name: 'Bob' },
    ])
    const admin = await UserFactory.state('admin').create()

    expect((await t.patch(`/api/users/${ada.id}`, { name: 'x' })).status).toBe(401)
    const forbidden = await (await t.actingAs(bob)).patch(`/api/users/${ada.id}`, { name: 'x' })
    expect([forbidden.status, forbidden.body.message]).toEqual([403, '只能修改自己的资料'])
    expect((await (await t.actingAs(bob)).delete(`/api/users/${ada.id}`)).status).toBe(403)
    expect((await (await t.actingAs(admin)).delete(`/api/users/${ada.id}`)).status).toBe(204)
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
