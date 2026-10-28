import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts'],
  platform: 'neutral',
  dts: true,
  // 与其它包一致输出 .mjs / .d.mts
  fixedExtension: true,
})
