import { defineSchedule, useApp } from '@hazejs/core'

export default defineSchedule((schedule) => {
  schedule.call('shop:prune-carts', () => {
    useApp().logger.info('Pruned abandoned carts')
  }).daily()
})
