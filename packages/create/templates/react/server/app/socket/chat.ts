import { defineNamespace } from '@hazejs/socket.io'

/**
 * Socket.IO 命名空间 /chat（前端：src/socket.ts）。
 * 需要登录时加 middleware: [authenticate()]，客户端 io('/chat', { auth: { token } })；
 * 在接口、任务、监听器中推送：SocketIO.of('/chat').emit('chat:message', text)
 */
export default defineNamespace({
  connection(socket, _io, chat) {
    chat.emit('online', chat.sockets.size)
    socket.on('chat:send', (text: string, ack?: (result: string) => void) => {
      chat.emit('chat:message', text)
      ack?.('ok')
    })
    socket.on('disconnect', () => chat.emit('online', chat.sockets.size))
  },
})
