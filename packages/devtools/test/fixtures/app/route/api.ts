import { defineRoutes } from '@hazejs/core'

export default defineRoutes((r) => {
  r.get('/hello', () => ({ message: 'hello' })).name('hello')
  r.post('/users', () => ({ created: true })).name('users.store')
})
