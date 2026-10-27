import { defineMiddlewareConfig } from '@think-h3/core'

// 请求 ID（x-request-id）与访问日志由框架内置，无需注册
// 内置中间件：cors、secureHeaders、compress、throttle:60,60、bodyLimit:10mb、session、auth / auth:api、guest
export default defineMiddlewareConfig({
  // 全局中间件，按顺序作用于所有请求
  global: ['secureHeaders', 'compress'],
  // 别名，在路由中按名引用：.middleware('auth')；用 think-h3 make:middleware 生成
  alias: {},
})
