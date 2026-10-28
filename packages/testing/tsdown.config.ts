import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts', 'src/config.ts'],
  platform: 'node',
  dts: true,
  // 由使用方的 Vitest（haze 插件）解析
  deps: {
    neverBundle: ['virtual:haze/app'],
  },
})
