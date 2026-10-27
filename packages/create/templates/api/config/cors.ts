import { defineCorsConfig, env } from '@think-h3/core'

// 跨域：CORS_ORIGIN 为逗号分隔的来源列表，默认允许任意来源（不携带 Cookie）
export default defineCorsConfig(() => {
  const origin = env('CORS_ORIGIN', '*')
  return {
    origin: origin === '*'
      ? '*'
      : origin.split(',').map(item => item.trim()),
  }
})
