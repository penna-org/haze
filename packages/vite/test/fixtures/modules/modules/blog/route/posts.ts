import { defineRoutes } from '@hazejs/core'
import { PostController } from '~/modules/blog/app/controller/PostController'

export default defineRoutes((r) => {
  r.get('/posts', [PostController, 'index']).name('posts.index')
  r.get('/posts/:id', [PostController, 'show']).name('posts.show')
})
