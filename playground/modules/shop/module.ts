import { defineModule } from '@hazejs/core'

/** 演示模块：订单事件、收据任务、清理定时任务，并与项目互相监听事件（DevTools 的模块联动图可见） */
export default defineModule({
  prefix: '/api/shop',
})
