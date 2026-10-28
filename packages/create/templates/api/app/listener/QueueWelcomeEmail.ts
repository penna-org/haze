import { defineListener } from '@hazejs/core'
import UserRegistered from '~/app/event/UserRegistered'
import SendWelcomeEmail from '~/app/job/SendWelcomeEmail'

/** 注册后投递欢迎邮件任务（耗时操作放到队列，不阻塞注册响应） */
export default defineListener(UserRegistered, ({ userId }) => SendWelcomeEmail.dispatch({ userId }))
