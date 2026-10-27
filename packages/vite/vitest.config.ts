import { defineProject } from 'vitest/config'

export default defineProject({
  test: {
    name: 'vite',
    environment: 'node',
    // 每个用例会启动真实的 Vite 开发服务器 / 构建
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})
