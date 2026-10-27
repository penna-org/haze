import { defineRoutes } from '@think-h3/core'
import { GreetingController } from '~/app/controller/GreetingController'
import { GreetSchema } from '~/app/validate/greeting'

export default defineRoutes((r) => {
  r.group({ prefix: '/api', as: 'api.' }, (r) => {
    r.get('/hello', [GreetingController, 'index']).name('hello')
    r.post('/hello', [GreetingController, 'store']).validate({ body: GreetSchema })
  })
})
