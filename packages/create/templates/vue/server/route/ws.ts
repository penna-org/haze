import { defineRoutes } from '@hazejs/core'

/**
 * WebSocket：ws://<host>/api/ws。升级请求同样经过中间件，需要登录时加 .middleware('auth')。
 * 服务端任意位置用 Socket.publish('users', data) 推送给订阅者（多实例见 config/websocket.ts）
 */
export default defineRoutes((r) => {
  r.ws('/api/ws', {
    open(peer) {
      peer.subscribe('users')
      peer.send(JSON.stringify({ type: 'connected' }))
    },
    message(peer, message) {
      if (message.text() === 'ping')
        peer.send(JSON.stringify({ type: 'pong' }))
    },
  })
})
