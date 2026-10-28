import { defineRoutes } from '@hazejs/core'

export default defineRoutes((r) => {
  r.get('/name', () => ({ name: 'modules' })).name('name')
})
