import news from '@demo/news'
import { defineModulesConfig } from '@hazejs/core'

export default defineModulesConfig({
  modules: [
    news({ prefix: '/news' }),
  ],
})
