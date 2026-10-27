import { fileURLToPath } from 'node:url'
import { thinkH3 } from '@think-h3/vite'
import { defineProject } from 'vitest/config'

export default defineProject({
  // 与 dev / build 共用同一个插件：提供 virtual:think/app 与 `~` 别名
  plugins: [
    thinkH3(),
  ],
  resolve: {
    alias: {
      // 仓库内直接使用 core 源码，修改内核无需先构建
      '@think-h3/core': fileURLToPath(new URL('../packages/core/src/index.ts', import.meta.url)),
    },
  },
  test: {
    name: 'playground',
    environment: 'node',
  },
})
