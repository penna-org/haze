import { defineProject } from 'vitest/config'

export default defineProject({
  test: {
    name: 'search',
    environment: 'node',
    // PGlite 与外部搜索服务在并行负载下初始化较慢
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})
