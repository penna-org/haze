import { fileURLToPath } from 'node:url'
import { defineHazeTestConfig } from '@hazejs/testing/config'
import { defineProject } from 'vitest/config'

export default defineProject(defineHazeTestConfig({
  resolve: {
    alias: {
      // 仓库内直接使用 core 源码，修改内核无需先构建
      '@hazejs/core': fileURLToPath(new URL('../packages/core/src/index.ts', import.meta.url)),
    },
  },
  test: {
    name: 'playground',
  },
}))
