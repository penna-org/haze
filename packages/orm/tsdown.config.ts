import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts', 'src/mongo/index.ts'],
  platform: 'node',
  dts: true,
})
