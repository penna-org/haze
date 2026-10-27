import { defineMiddlewareConfig } from '@think-h3/core'
import { Authenticate } from '~/app/middleware/Authenticate'
import { requestId } from '~/app/middleware/requestId'

export default defineMiddlewareConfig({
  global: [requestId],
  alias: {
    auth: Authenticate,
  },
})
