import { button, defineMail, html, mailLayout } from '@hazejs/core'

/** 欢迎邮件（app/job/SendWelcomeEmail.ts 发送）：函数返回主题与 html，纯文本版本自动生成 */
export default defineMail((payload: { name: string, url: string }) => ({
  subject: `欢迎加入，${payload.name}`,
  html: mailLayout({
    brand: '{{name}}',
    preheader: '感谢注册，开始使用吧',
    body: html`
      <h1 style="margin:0 0 16px;font-size:22px">你好，${payload.name}</h1>
      <p>感谢注册！点击下方按钮开始使用。</p>
      ${button('开始使用', payload.url)}
      <p style="color:#71717a">如果这不是你本人的操作，请忽略这封邮件。</p>
    `,
    footer: '此邮件由系统自动发送，请勿直接回复',
  }),
}), { name: 'WelcomeMail' })
