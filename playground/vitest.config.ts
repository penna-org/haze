import { fileURLToPath } from 'node:url'
import { defineProject } from 'vitest/config'

export default defineProject({
  resolve: {
    alias: {
      // M1 阶段直接指向源码，免去先构建 core
      '@think-h3/core': fileURLToPath(new URL('../packages/core/src/index.ts', import.meta.url)),
      '~': fileURLToPath(new URL('.', import.meta.url)),
    },
  },
  test: {
    name: 'playground',
    environment: 'node',
  },
})
