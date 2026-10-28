import { Events, Mail, MailFake, Queue, Storage } from '@think-h3/core'
import { refreshDatabase } from '@think-h3/orm'
import { useTestApp } from '@think-h3/testing'
import { beforeEach, describe, expect, it } from 'vitest'
import UserRegistered from '~/app/event/UserRegistered'
import SendWelcomeEmail from '~/app/job/SendWelcomeEmail'
import WelcomeMail from '~/app/mail/WelcomeMail'
import { User } from '~/app/model/User'

const t = useTestApp()
let fake: ReturnType<typeof Queue.fake>
// 队列改为记录投递，断言后可用 fake.drain() 执行
beforeEach(() => {
  fake = Queue.fake()
})
beforeEach(() => refreshDatabase({ migrations: 'database/migrations' }))

const ada = { name: 'Ada', email: 'ada@example.com', password: 'correct horse' }

describe('auth', () => {
  it('registers, logs in and reads the current user with a Bearer token', async () => {
    const registered = await t.post('/api/auth/register', ada)
    expect(registered.status).toBe(201)
    expect(registered.body.data.user).toMatchObject({ name: 'Ada', email: 'ada@example.com' })
    // 密码哈希不会出现在响应中
    expect(registered.body.data.user).not.toHaveProperty('password')
    // 注册事件的监听器投递欢迎邮件任务（app/listener/QueueWelcomeEmail.ts）
    fake.assertDispatched(SendWelcomeEmail, payload => payload.userId === registered.body.data.user.id)
    // 执行任务：发送欢迎邮件（Mail.fake() 只记录不投递）
    const mail = Mail.fake()
    await fake.drain()
    mail.assertSent(WelcomeMail, sent => MailFake.hasRecipient(sent, ada.email) && sent.message.subject === '欢迎加入，Ada')

    const login = await t.post('/api/auth/login', { email: ada.email, password: ada.password })
    expect(login.body.data).toMatchObject({ type: 'Bearer', expiresIn: 7200 })

    const me = await t.withHeaders({ authorization: `Bearer ${login.body.data.token}` }).get('/api/auth/me')
    expect(me.body.data).toMatchObject({ email: 'ada@example.com' })
  })

  it('emits UserRegistered on registration', async () => {
    const events = Events.fake([UserRegistered])
    const registered = await t.post('/api/auth/register', ada)
    events.assertEmitted(UserRegistered, payload => payload.userId === registered.body.data.user.id && payload.email === ada.email)
    // 事件被 fake 后监听器不执行，任务也不会投递
    fake.assertNotDispatched(SendWelcomeEmail)
  })

  it('rejects wrong passwords and anonymous requests with 401', async () => {
    await t.post('/api/auth/register', ada)
    const wrong = await t.post('/api/auth/login', { email: ada.email, password: 'nope' })
    expect([wrong.status, wrong.body.message]).toEqual([401, '邮箱或密码错误'])
    expect((await t.get('/api/auth/me')).status).toBe(401)
  })

  it('actingAs() logs a user in without going through the login endpoint', async () => {
    const user = await User.create({ name: 'Bob', email: 'bob@example.com' })
    const me = await (await t.actingAs(user)).get('/api/auth/me')
    expect(me.body.data).toMatchObject({ id: user.id, email: 'bob@example.com' })
  })

  it('uploads an avatar to the public disk', async () => {
    const disk = Storage.fake('public')
    const user = await User.create({ name: 'Bob', email: 'bob@example.com' })
    const form = new FormData()
    form.set('avatar', new File([
      new Uint8Array([137, 80, 78, 71]),
    ], 'me.png', { type: 'image/png' }))
    const res = await (await t.actingAs(user)).post('/api/auth/avatar', form)
    expect(res.status).toBe(201)
    expect(res.body.data.url).toBe(`/storage/${res.body.data.path}`)
    await disk.assertExists(res.body.data.path)

    form.set('avatar', new File(['text'], 'a.txt', { type: 'text/plain' }))
    expect((await (await t.actingAs(user)).post('/api/auth/avatar', form)).status).toBe(422)
  })
})
