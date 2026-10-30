import { defineRoutes } from '@hazejs/core'

export default defineRoutes((r) => {
  r.get('/posts', () => []).name('posts.index')
  r.get('/posts/:id', () => ({})).name('posts.show')
})
