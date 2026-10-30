import { HttpManager } from '@hazejs/core'
import { useTestApp } from '@hazejs/testing'
import { describe, expect, it } from 'vitest'

// Http.fake() 属于当前应用：useTestApp() 每个用例一个新应用，假响应与记录不会泄漏到下一个用例
const t = useTestApp({
  override: container => void container.instance(Logger, new Logger({ level: 'silent' })),
})

describe('http fake with useTestApp', () => {
  it('fakes requests within a test', async () => {
    Http.preventStrayRequests()
    Http.fake({
      'api.example.com/*': Http.response({ name: 'Ada' }),
    })
    const res = await Http.get('https://api.example.com/users/1')
    expect(await res.json()).toEqual({ name: 'Ada' })
    Http.assertSent(request => request.url === 'https://api.example.com/users/1')
    expect(Http.manager()).toBe(t.make(HttpManager))
  })

  it('starts the next test without fakes or recorded requests', () => {
    expect(Http.manager()).toBe(t.make(HttpManager))
    expect(Http.manager().faking).toBeUndefined()
    expect(() => Http.assertNothingSent()).toThrow('Http.fake() has not been called')
  })
})
