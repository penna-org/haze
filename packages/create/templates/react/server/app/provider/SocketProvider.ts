import { socketIoProvider } from '@hazejs/socket.io'

// Socket.IO：app/socket 下的命名空间自动注册，与 HTTP 共用端口（/socket.io/）
export default socketIoProvider()
