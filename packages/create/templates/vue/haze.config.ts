import { defineHazeConfig } from '@hazejs/vite'

export default defineHazeConfig({
  // 后端源码目录（config/ route/ app/ 位于其中）
  srcDir: 'server',
  // 生产环境端口（开发时使用 Vite 的端口）
  port: 3000,
})
