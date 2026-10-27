import { fileURLToPath } from 'node:url'
import { defineThinkTestConfig } from '@think-h3/testing/config'
import { defineProject } from 'vitest/config'

export default defineProject(defineThinkTestConfig({
  resolve: {
    alias: {
      // 仓库内直接使用 core 源码，修改内核无需先构建
      '@think-h3/core': fileURLToPath(new URL('../packages/core/src/index.ts', import.meta.url)),
    },
  },
  test: {
    name: 'playground',
  },
}))
