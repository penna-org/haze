import { defineMiddlewareConfig } from '@think-h3/core'
import { Authenticate } from '~/app/middleware/Authenticate'

// 请求 ID（x-request-id）与访问日志由框架内置，无需注册
export default defineMiddlewareConfig({
  global: [],
  alias: {
    auth: Authenticate,
  },
})
