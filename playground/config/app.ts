import { defineConfig, env } from '@think-h3/core'

// 读取环境变量时使用函数形式，确保在 .env 加载之后求值
export default defineConfig(() => ({
  name: env('APP_NAME', 'think-h3'),
  debug: env('APP_DEBUG', false),
}))
