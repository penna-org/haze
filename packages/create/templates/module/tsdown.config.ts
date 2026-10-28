import { defineConfig } from 'tsdown'

// 发布产物：dist/index.mjs + 类型声明（含 config 的类型扩充）；迁移目录 database/ 随包发布（见 package.json 的 files）
export default defineConfig({
  entry: ['src/index.ts'],
  platform: 'node',
  dts: true,
})
