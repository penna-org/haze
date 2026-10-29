import { fileURLToPath } from 'node:url'
import { defineProject } from 'vitest/config'

export default defineProject({
  // TSX 视图测试：使用源码中的 JSX 运行时
  oxc: {
    jsx: { runtime: 'automatic', importSource: '@hazejs/core' },
  },
  resolve: {
    alias: {
      '@hazejs/core/jsx-runtime': fileURLToPath(new URL('./src/jsx-runtime.ts', import.meta.url)),
      '@hazejs/core/jsx-dev-runtime': fileURLToPath(new URL('./src/jsx-dev-runtime.ts', import.meta.url)),
    },
  },
  test: {
    name: 'core',
    environment: 'node',
  },
})
