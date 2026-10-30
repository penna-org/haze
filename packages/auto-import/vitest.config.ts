import { defineProject } from 'vitest/config'

export default defineProject({
  test: {
    name: 'auto-import',
    environment: 'node',
    // 用例会创建完整的 TypeScript 程序（含 @types/node 与 core / orm 源码）或启动 Vite，CI 上明显慢于本机
    testTimeout: 30_000,
  },
})
