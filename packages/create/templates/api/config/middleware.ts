import { defineMiddlewareConfig } from '@think-h3/core'
import { requestId } from '~/app/middleware/requestId'

export default defineMiddlewareConfig({
  // 全局中间件，按顺序作用于所有请求
  global: [requestId],
  // 别名，在路由中按名引用：.middleware('auth')
  alias: {},
})
