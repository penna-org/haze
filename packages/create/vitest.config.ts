import { defineProject } from 'vitest/config'

export default defineProject({
  test: {
    name: 'create',
    environment: 'node',
    // 模板自带的测试由用例内单独运行，不在这里收集
    include: ['test/**/*.test.ts'],
    exclude: ['test/.tmp/**'],
    testTimeout: 120_000,
    hookTimeout: 60_000,
  },
})
