import { defineProvider } from '@hazejs/core'
import { GreetingService } from '~/app/service/GreetingService'

/** 服务提供者：register() 中注册绑定，boot() 中执行启动逻辑 */
export default defineProvider({
  register(container) {
    container.singleton(GreetingService)
  },
})
