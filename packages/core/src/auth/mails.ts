import { button, html, mailLayout } from '../mail/layout'
import { defineMail } from '../mail/mailable'

export interface VerifyEmailPayload {
  /** 应用名（config/app.ts 的 name），用作品牌与标题 */
  appName: string
  /** 收件人称呼（用户的 name 字段，可能为空） */
  name?: string
  url: string
  /** 链接有效期（分钟） */
  expiresInMinutes: number
}

/** 默认的邮箱验证邮件（可在 config/auth.ts 的 verification.mail 中替换） */
export const VerifyEmailMail = defineMail((payload: VerifyEmailPayload) => ({
  subject: `验证你的邮箱 - ${payload.appName}`,
  html: mailLayout({
    brand: payload.appName,
    preheader: '点击链接完成邮箱验证',
    body: html`<p>${payload.name
      ? `${payload.name}，你好：`
      : '你好：'}</p>
<p>请点击下面的按钮验证你的邮箱地址。</p>
${button('验证邮箱', payload.url)}
<p style="color:#71717a;font-size:13px">链接 ${payload.expiresInMinutes} 分钟内有效。如果你没有注册账号，请忽略这封邮件。</p>`,
    footer: payload.appName,
  }),
}), { name: 'auth:verify-email' })

export interface ResetPasswordPayload {
  appName: string
  name?: string
  url: string
  expiresInMinutes: number
}

/** 默认的重置密码邮件（可在 config/auth.ts 的 passwords.mail 中替换） */
export const ResetPasswordMail = defineMail((payload: ResetPasswordPayload) => ({
  subject: `重置密码 - ${payload.appName}`,
  html: mailLayout({
    brand: payload.appName,
    preheader: '你正在重置密码',
    body: html`<p>${payload.name
      ? `${payload.name}，你好：`
      : '你好：'}</p>
<p>我们收到了重置你账号密码的请求，点击下面的按钮设置新密码。</p>
${button('重置密码', payload.url)}
<p style="color:#71717a;font-size:13px">链接 ${payload.expiresInMinutes} 分钟内有效。如果不是你本人操作，请忽略这封邮件，密码不会改变。</p>`,
    footer: payload.appName,
  }),
}), { name: 'auth:reset-password' })
