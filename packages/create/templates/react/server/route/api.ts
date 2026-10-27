import { defineRoutes } from '@think-h3/core'
import { GreetingController } from '~/app/controller/GreetingController'
import { UserController } from '~/app/controller/UserController'
import { GreetSchema } from '~/app/validate/greeting'
import { UserIdParams } from '~/app/validate/user'

export default defineRoutes((r) => {
  r.group({ prefix: '/api', as: 'api.' }, (r) => {
    r.get('/hello', [GreetingController, 'index']).name('hello')
    r.post('/hello', [GreetingController, 'store']).validate({ body: GreetSchema })
    r.resource('/users', UserController).validateMember({ params: UserIdParams })
  })
})
