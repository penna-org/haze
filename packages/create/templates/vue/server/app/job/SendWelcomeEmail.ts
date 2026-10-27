import { defineJob } from '@think-h3/core'
import { User } from '~/app/model/User'

/** 注册成功后投递（AuthController.register）：示例中只写日志，替换为真实的邮件发送 */
const SendWelcomeEmail = defineJob({
  tries: 3,
  backoff: [10, 60],
  timeout: '30s',
  async handle(payload: { userId: number }, job) {
    const user = await User.find(payload.userId)
    if (!user)
      return
    job.logger.info(`Welcome email sent to ${user.email}`)
  },
})

export default SendWelcomeEmail
