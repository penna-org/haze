import { defineMiddleware } from '@think-h3/core'

export const requestId = defineMiddleware(async (ctx, next) => {
  const id = ctx.header('x-request-id') ?? crypto.randomUUID()
  ctx.set('requestId', id)
  ctx.setHeader('x-request-id', id)
  return next()
})
