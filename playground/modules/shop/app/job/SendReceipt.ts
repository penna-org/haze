import { defineJob } from '@hazejs/core'

export default defineJob<{ orderId: number }>({
  name: 'SendReceipt',
  tries: 3,
  handle: ({ orderId }, job) => {
    job.logger.info(`Receipt sent for order ${orderId}`)
  },
})
