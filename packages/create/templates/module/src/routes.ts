import { defineRoutes } from '@hazejs/core'
import { PostController } from './controller/PostController'

// 挂载在模块前缀下（默认 /api/{{name}}，启用时可改）；路由名自动带 '{{moduleName}}.' 前缀
export default defineRoutes((r) => {
  r.get('/posts', [PostController, 'index']).name('posts.index')
  r.post('/posts', [PostController, 'store']).middleware('{{moduleName}}.json').name('posts.store')
})
