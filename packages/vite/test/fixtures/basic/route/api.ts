import { defineRoutes } from '@think-h3/core'
import { HelloController } from '~/app/controller/HelloController'

export default defineRoutes((r) => {
  r.get('/hello', [HelloController, 'index'])
  r.get('/name', [HelloController, 'name'])
  r.get('/visits', [HelloController, 'visits'])
  r.get('/slow', [HelloController, 'slow'])
})
