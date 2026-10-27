import { defineListener, Socket } from '@think-h3/core'
import UserRegistered from '~/app/event/UserRegistered'

/** 实时推送：订阅了 users 的 WebSocket 连接（route/ws.ts）收到新用户注册的消息 */
export default defineListener(UserRegistered, ({ userId }) => {
  Socket.publish('users', { type: 'user.registered', userId })
})
