import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/columns.ts',
    'src/mongo/index.ts',
    'src/auto-imports.ts',
  ],
  platform: 'node',
  dts: true,
})
