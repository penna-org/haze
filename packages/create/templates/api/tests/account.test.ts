import { Mail, ResetPasswordMail, VerifyEmailMail } from '@hazejs/core'
import { refreshDatabase } from '@hazejs/orm'
import { useTestApp } from '@hazejs/testing'
import { beforeEach, describe, expect, it } from 'vitest'
import { User } from '~/app/model/User'

const t = useTestApp()
beforeEach(() => refreshDatabase({ migrations: 'database/migrations' }))

/** 邮件中的链接（相对路径；设置 APP_URL 后为绝对链接） */
function linkOf(mail: ReturnType<typeof Mail.fake>): URL {
  return new URL((mail.sent.at(-1)!.payload as { url: string }).url, 'http://localhost')
}

describe('account', () => {
  it('issues, uses, lists and revokes personal access tokens', async () => {
    const user = await User.create({ name: 'Ada', email: 'ada@example.com' })
    const client = await t.actingAs(user)
    const created = await client.post('/api/auth/tokens', {
      name: 'cli',
      abilities: ['users:read'],
    })
    expect(created.status).toBe(201)
    const { token, accessToken } = created.body.data
    expect(token).toMatch(/^\d+\|/)
    expect(accessToken).toMatchObject({
      name: 'cli',
      abilities: ['users:read'],
    })

    // 用令牌访问（/me 同时接受 JWT 与个人访问令牌）
    const me = await t.withHeaders({ authorization: `Bearer ${token}` }).get('/api/auth/me')
    expect(me.body.data).toMatchObject({ email: 'ada@example.com' })

    const list = await client.get('/api/auth/tokens')
    expect(list.body.data).toEqual([
      expect.objectContaining({ id: accessToken.id, name: 'cli' }),
    ])
    expect(list.body.data[0]).not.toHaveProperty('token')

    expect((await client.delete(`/api/auth/tokens/${accessToken.id}`)).status).toBe(204)
    expect((await t.withHeaders({ authorization: `Bearer ${token}` }).get('/api/auth/me')).status).toBe(401)
  })

  it('sends a signed verification link on registration and verifies the email', async () => {
    const mail = Mail.fake()
    const registered = await t.post('/api/auth/register', { name: 'Ada', email: 'ada@example.com', password: 'correct horse' })
    mail.assertSent(VerifyEmailMail)
    const link = linkOf(mail)
    expect(link.pathname).toMatch(/^\/api\/auth\/email\/verify\/\d+\/\w+$/)

    // 篡改签名返回 403
    const tampered = `${link.pathname}?${link.searchParams.toString().replace(/signature=./, 'signature=x')}`
    expect((await t.get(tampered)).status).toBe(403)

    const verified = await t.get(`${link.pathname}${link.search}`)
    expect(verified.body.data).toEqual({ status: 'verified' })
    const user = await User.findOrFail(registered.body.data.user.id)
    expect(user.emailVerifiedAt).toBeInstanceOf(Date)

    // 已验证后不再发送
    const again = await (await t.actingAs(user)).post('/api/auth/email/verification-notification')
    expect(again.body.data).toEqual({ status: 'verified' })
  })

  it('resets a forgotten password with the emailed token', async () => {
    await t.post('/api/auth/register', { name: 'Ada', email: 'ada@example.com', password: 'correct horse' })
    const mail = Mail.fake()
    expect((await t.post('/api/auth/forgot-password', { email: 'ada@example.com' })).body.data).toEqual({ status: 'sent' })
    // 未注册的邮箱返回同样的结果，但不发邮件
    expect((await t.post('/api/auth/forgot-password', { email: 'nobody@example.com' })).body.data).toEqual({ status: 'sent' })
    mail.assertSentTimes(ResetPasswordMail, 1)
    const link = linkOf(mail)
    expect(link.pathname).toBe('/reset-password')

    const input = {
      email: 'ada@example.com',
      token: link.searchParams.get('token'),
      password: 'battery staple',
    }
    expect((await t.post('/api/auth/reset-password', { ...input, token: 'wrong' })).status).toBe(422)
    expect((await t.post('/api/auth/reset-password', input)).body.data).toEqual({ status: 'reset' })
    const login = await t.post('/api/auth/login', { email: 'ada@example.com', password: 'battery staple' })
    expect(login.status).toBe(200)
  })

  it('disables GitHub login until GITHUB_CLIENT_ID is set', async () => {
    expect((await t.get('/api/auth/github')).status).toBe(404)
  })
})
