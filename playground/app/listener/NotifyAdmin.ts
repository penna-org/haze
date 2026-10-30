import { defineListener } from '@hazejs/core'
import OrderPlaced from '~/modules/shop/app/event/OrderPlaced'

/** 监听 shop 模块的事件（排队执行） */
export default defineListener(OrderPlaced, ({ orderId }, { logger }) => {
  logger.info(`New order #${orderId}`)
}, { name: 'NotifyAdmin', queue: true })
