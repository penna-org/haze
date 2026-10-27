import type { Socket } from 'socket.io-client'
import { io } from 'socket.io-client'

/** Socket.IO 命名空间 /chat（server/app/socket/chat.ts）：与页面同源，开发时由 Vite 开发服务器交给后端 */
export const chat: Socket = io('/chat', { autoConnect: false })
