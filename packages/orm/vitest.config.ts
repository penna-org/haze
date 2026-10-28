import { defineProject } from 'vitest/config'

export default defineProject({
  test: {
    name: 'orm',
    environment: 'node',
    // PGlite 在并行负载下初始化较慢
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // MySQL / Turso 等真实服务在多个测试文件间共用同一个库（同名表），按文件串行执行
    fileParallelism: false,
  },
})
