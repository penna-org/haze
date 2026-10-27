import { useTestApp } from '@think-h3/testing'
import { describe, expect, it } from 'vitest'

const t = useTestApp()

describe('greeting', () => {
  it('says hello', async () => {
    const res = await t.get('/api/hello')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      code: 0,
      message: 'ok',
      data: { app: '{{name}}', message: 'Hello, think-h3!' },
    })
  })

  it('greets by name', async () => {
    const res = await t.post('/api/hello', { name: ' Ada ' })
    expect(res.body.data).toEqual({ message: 'Hello, Ada!' })
  })

  it('validates the request body', async () => {
    const res = await t.post('/api/hello', { name: '' })
    expect(res.status).toBe(422)
    expect(res.body.errors).toEqual([
      { target: 'body', path: 'name', message: 'name 不能为空' },
    ])
  })
})
