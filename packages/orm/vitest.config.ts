import { defineProject } from 'vitest/config'

export default defineProject({
  test: {
    name: 'orm',
    environment: 'node',
    // PGlite 在并行负载下初始化较慢
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})
