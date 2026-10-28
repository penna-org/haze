import { defineRoutes } from '@hazejs/core'
import { AuthController } from '~/app/controller/AuthController'
import { ChatController } from '~/app/controller/ChatController'
import { GreetingController } from '~/app/controller/GreetingController'
import { OAuthController } from '~/app/controller/OAuthController'
import { PasswordResetController } from '~/app/controller/PasswordResetController'
import { TokenController } from '~/app/controller/TokenController'
import { UserController } from '~/app/controller/UserController'
import { VerificationController } from '~/app/controller/VerificationController'
import { ChatSchema } from '~/app/validate/chat'
import { GreetSchema } from '~/app/validate/greeting'
import { UserIdParams } from '~/app/validate/user'

export default defineRoutes((r) => {
  r.group({ prefix: '/api', as: 'api.' }, (r) => {
    r.get('/hello', [GreetingController, 'index']).name('hello')
    // 下发 XSRF-TOKEN Cookie（前端首次发起修改类请求前调用，见 src/api.ts）
    r.get('/csrf-cookie', ctx => ctx.noContent())
    r.post('/hello', [GreetingController, 'store']).validate({ body: GreetSchema })
    r.resource('/users', UserController).validateMember({ params: UserIdParams })
    // AI 流式对话（SSE）；限流防止滥用
    r.post('/chat', [ChatController, 'chat']).validate({ body: ChatSchema }).middleware('throttle:20,60').name('chat')

    r.group({ prefix: '/auth', as: 'auth.' }, (r) => {
      r.post('/register', [AuthController, 'register']).name('register')
      // 登录限流：同一 IP 每分钟最多 10 次
      r.post('/login', [AuthController, 'login']).middleware('throttle:10,60').name('login')
      // JWT 或个人访问令牌都可以访问
      r.get('/me', [AuthController, 'me']).middleware('auth:api,token').name('me')
      r.post('/avatar', [AuthController, 'avatar']).middleware(['auth', 'bodyLimit:3mb']).name('avatar')

      // 个人访问令牌：签发 / 列出 / 吊销
      r.get('/tokens', [TokenController, 'index']).middleware('auth').name('tokens.index')
      r.post('/tokens', [TokenController, 'store']).middleware('auth').name('tokens.store')
      r.delete('/tokens/:id', [TokenController, 'destroy']).middleware('auth').name('tokens.destroy')

      // 邮箱验证：链接带签名与有效期（verifyEmail() 校验）
      r.post('/email/verification-notification', [VerificationController, 'send']).middleware(['auth', 'throttle:6,60']).name('verification.send')
      r.get('/email/verify/:id/:hash', [VerificationController, 'verify']).middleware('throttle:6,60').name('verification.verify')

      // 找回密码
      r.post('/forgot-password', [PasswordResetController, 'forgot']).middleware('throttle:6,60').name('password.email')
      r.post('/reset-password', [PasswordResetController, 'reset']).middleware('throttle:6,60').name('password.update')

      // GitHub 登录（config/oauth.ts，未配置时返回 404）
      r.get('/github', [OAuthController, 'redirect']).name('github')
      r.get('/github/callback', [OAuthController, 'callback']).name('github.callback')
    })
  })
})
