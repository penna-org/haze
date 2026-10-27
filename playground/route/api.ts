import { defineRoutes } from '@think-h3/core'
import { HomeController } from '~/app/controller/HomeController'
import { UserController } from '~/app/controller/UserController'
import { UserIdParams } from '~/app/validate/user'

export default defineRoutes((r) => {
  r.get('/', [HomeController, 'index']).name('home')

  r.group({ prefix: '/api', as: 'api.' }, (r) => {
    r.get('/me', [UserController, 'me']).name('me')

    r.resource('/users', UserController).validateMember({ params: UserIdParams })
  })
})
