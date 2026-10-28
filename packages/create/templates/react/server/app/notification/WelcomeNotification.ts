import type { User } from '~/app/model/User'
import { button, defineNotification, html, mailLayout } from '@hazejs/core'

/**
 * 欢迎通知示例：发送邮件，并实时推送到用户的私有频道 private-User.<id>（授权见 app/channel/user.ts）。
 * 发送：await notify(user, WelcomeNotification({ url: 'http://localhost:5173' }))
 * 前端：echo.private(`User.${user.id}`).notification(data => ...)（@hazejs/core/echo）
 * 写入数据库：运行 haze make:notifications-table，配置 config/notification.ts 后在 via 中加入 'database'
 */
export default defineNotification<{ url: string }, User>({
  via: () => ['mail', 'broadcast'],
  toMail: (user, { url }) => ({
    subject: `欢迎加入，${user.name}`,
    html: mailLayout({
      brand: '{{name}}',
      body: html`<p>你好，${user.name}，感谢注册！</p>${button('开始使用', url)}`,
    }),
  }),
  toBroadcast: user => ({ message: `欢迎加入，${user.name}` }),
})
