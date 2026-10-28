import { defineModule, defineRoutes } from '@hazejs/core'

export default defineModule({
  name: 'news',
  config: {
    news: { limit: 5 },
  },
  routes: [
    defineRoutes((r) => {
      r.get('/latest', ctx => ({
        headline: 'news v1',
        limit: ctx.config.get('news.limit', 0),
      })).name('latest')
    }),
  ],
  migrations: new URL('../database/migrations', import.meta.url),
})
