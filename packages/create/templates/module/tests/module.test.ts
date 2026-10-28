import { refreshDatabase } from '@hazejs/orm'
import { useTestApp } from '@hazejs/testing'
import { beforeEach, describe, expect, it } from 'vitest'

// 每个用例一个全新的宿主应用（tests/app），模块的迁移在 refreshDatabase() 中执行
const t = useTestApp()
beforeEach(() => refreshDatabase())

describe('{{name}}', () => {
  it('creates and lists posts under the module prefix', async () => {
    const created = await t.post('/api/{{name}}/posts', { title: ' Hello ' })
    expect(created.status).toBe(200)
    expect(created.body.data).toMatchObject({ id: 1, title: 'Hello' })

    const list = await t.get('/api/{{name}}/posts')
    expect(list.body.data.map((post: { title: string }) => post.title)).toEqual(['Hello'])
  })

  it('applies the options passed when the module is enabled', async () => {
    for (const title of ['a', 'b', 'c'])
      await t.post('/api/{{name}}/posts', { title })
    // tests/app/config/modules.ts 启用时传入 perPage: 2
    const list = await t.get('/api/{{name}}/posts')
    expect(list.body.data.map((post: { title: string }) => post.title)).toEqual(['c', 'b'])
  })

  it('registers its middleware alias and named routes', async () => {
    const rejected = await t.post('/api/{{name}}/posts', 'title=x', {
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    })
    expect(rejected.status).toBe(415)
    expect(t.app.router.url('{{moduleName}}.posts.index')).toBe('/api/{{name}}/posts')
  })
})
