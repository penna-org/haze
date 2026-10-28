import { defineMiddlewareConfig } from '@hazejs/core'

// 请求 ID（x-request-id）与访问日志由框架内置，无需注册
// 内置中间件：cors、secureHeaders、compress、throttle:60,60、bodyLimit:10mb、session、auth / auth:api、guest
export default defineMiddlewareConfig({
  // 全局中间件，按顺序作用于所有请求
  // csrf：修改类请求须带 X-XSRF-TOKEN（src/api.ts 自动处理），Bearer 请求不受影响
  global: ['secureHeaders', 'compress', 'csrf'],
  // 别名，在路由中按名引用：.middleware('auth')；用 haze make:middleware 生成
  alias: {},
})
