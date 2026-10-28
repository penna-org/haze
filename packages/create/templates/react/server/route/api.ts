import { defineRoutes } from '@think-h3/core'
import { AuthController } from '~/app/controller/AuthController'
import { GreetingController } from '~/app/controller/GreetingController'
import { UserController } from '~/app/controller/UserController'
import { GreetSchema } from '~/app/validate/greeting'
import { UserIdParams } from '~/app/validate/user'

export default defineRoutes((r) => {
  r.group({ prefix: '/api', as: 'api.' }, (r) => {
    r.get('/hello', [GreetingController, 'index']).name('hello')
    // 下发 XSRF-TOKEN Cookie（前端首次发起修改类请求前调用，见 src/api.ts）
    r.get('/csrf-cookie', ctx => ctx.noContent())
    r.post('/hello', [GreetingController, 'store']).validate({ body: GreetSchema })
    r.resource('/users', UserController).validateMember({ params: UserIdParams })

    r.group({ prefix: '/auth', as: 'auth.' }, (r) => {
      r.post('/register', [AuthController, 'register']).name('register')
      // 登录限流：同一 IP 每分钟最多 10 次
      r.post('/login', [AuthController, 'login']).middleware('throttle:10,60').name('login')
      r.get('/me', [AuthController, 'me']).middleware('auth').name('me')
      r.post('/avatar', [AuthController, 'avatar']).middleware(['auth', 'bodyLimit:3mb']).name('avatar')
    })
  })
})
