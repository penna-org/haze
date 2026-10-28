import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts', 'src/adapters/cloudflare.ts', 'src/client.ts'],
  // Workers 运行时内置模块
  deps: {
    neverBundle: [/^cloudflare:/],
  },
  platform: 'node',
  dts: true,
})
