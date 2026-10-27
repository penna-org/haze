import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts', 'src/scaffold.ts'],
  platform: 'node',
  dts: true,
})
