import { defineJob, Mail } from '@hazejs/core'
import WelcomeMail from '~/app/mail/WelcomeMail'
import { User } from '~/app/model/User'

/** 注册成功后投递（app/listener/QueueWelcomeEmail.ts）：发送欢迎邮件，失败时按 backoff 重试 */
const SendWelcomeEmail = defineJob({
  tries: 3,
  backoff: [10, 60],
  timeout: '30s',
  async handle(payload: { userId: number }, job) {
    const user = await User.find(payload.userId)
    if (!user)
      return
    await Mail.to({ address: user.email, name: user.name }).send(WelcomeMail, { name: user.name, url: 'http://localhost:5173' })
    job.logger.info(`Welcome email sent to ${user.email}`)
  },
})

export default SendWelcomeEmail
