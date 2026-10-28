import { defineRoutes } from '@hazejs/core'
import { AuthController } from '~/app/controller/AuthController'
import { ChatController } from '~/app/controller/ChatController'
import { GreetingController } from '~/app/controller/GreetingController'
import { UserController } from '~/app/controller/UserController'
import { ChatSchema } from '~/app/validate/chat'
import { GreetSchema } from '~/app/validate/greeting'
import { UserIdParams } from '~/app/validate/user'

export default defineRoutes((r) => {
  r.group({ prefix: '/api', as: 'api.' }, (r) => {
    r.get('/hello', [GreetingController, 'index']).name('hello')
    r.post('/hello', [GreetingController, 'store']).validate({ body: GreetSchema })
    r.resource('/users', UserController).validateMember({ params: UserIdParams })
    // AI 流式对话（SSE）；限流防止滥用
    r.post('/chat', [ChatController, 'chat']).validate({ body: ChatSchema }).middleware('throttle:20,60').name('chat')

    r.group({ prefix: '/auth', as: 'auth.' }, (r) => {
      r.post('/register', [AuthController, 'register']).name('register')
      // 登录限流：同一 IP 每分钟最多 10 次
      r.post('/login', [AuthController, 'login']).middleware('throttle:10,60').name('login')
      r.get('/me', [AuthController, 'me']).middleware('auth').name('me')
      r.post('/avatar', [AuthController, 'avatar']).middleware(['auth', 'bodyLimit:3mb']).name('avatar')
    })
  })
})
