import { config, defineRoutes } from '@hazejs/core'
import Welcome from '~/app/view/Welcome'

/** 页面路由：服务端渲染的 TSX 视图（app/view），返回 text/html，不经过统一响应格式 */
export default defineRoutes((r) => {
  r.get('/', ctx => ctx.view(Welcome, {
    app: config('app.name'),
  })).name('home')
})
