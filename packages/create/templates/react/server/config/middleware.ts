import { defineMiddlewareConfig } from '@think-h3/core'

// 请求 ID（x-request-id）与访问日志由框架内置，无需注册
export default defineMiddlewareConfig({
  // 全局中间件，按顺序作用于所有请求
  global: [],
  // 别名，在路由中按名引用：.middleware('auth')；用 think-h3 make:middleware 生成
  alias: {},
})
