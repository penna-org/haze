import { generateText } from '@hazejs/ai'
import { defineRoutes } from '@hazejs/core'
import { HomeController } from '~/app/controller/HomeController'
import { UserController } from '~/app/controller/UserController'
import UserRegistered from '~/app/event/UserRegistered'
import { UserIdParams } from '~/app/validate/user'

export default defineRoutes((r) => {
  r.get('/', [HomeController, 'index']).name('home')

  r.group({ prefix: '/api', as: 'api.' }, (r) => {
    r.get('/me', [UserController, 'me']).name('me')

    // 触发项目事件，shop 模块的监听器会收到（DevTools 的模块联动图中可见）
    r.post('/register', async () => {
      await UserRegistered.emit({ name: 'Ada' })
      return { registered: true }
    }).name('register')

    // 调用 config/ai.ts 中的本地 echo 模型（DevTools 的 AI 面板可见）
    r.get('/ask', async ctx => (await generateText({
      system: 'You are a parrot.',
      prompt: ctx.query('q') ?? 'hello',
    })).text).name('ask')

    r.resource('/users', UserController).validateMember({ params: UserIdParams })
  })
})
