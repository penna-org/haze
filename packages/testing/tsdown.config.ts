import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts', 'src/config.ts'],
  platform: 'node',
  dts: true,
  // 由使用方的 Vitest（thinkH3 插件）解析
  deps: {
    neverBundle: ['virtual:think/app'],
  },
})
