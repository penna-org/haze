// 请求 ID（x-request-id）与访问日志由框架内置，无需注册
export default defineMiddlewareConfig({
  global: [],
  alias: {
    auth: Authenticate,
  },
})
