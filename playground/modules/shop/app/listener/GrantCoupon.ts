import { defineListener } from '@hazejs/core'
import UserRegistered from '~/app/event/UserRegistered'

/** 监听项目的事件：新用户注册后发放优惠券 */
export default defineListener(UserRegistered, ({ name }, { logger }) => {
  logger.info(`Coupon granted to ${name}`)
}, { name: 'GrantCoupon' })
