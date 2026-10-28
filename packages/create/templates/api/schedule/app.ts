import { defineSchedule } from '@hazejs/core'

/**
 * 定时任务：haze schedule:work（开发 / 常驻），或系统 cron 每分钟执行 haze schedule:run；
 * 构建产物：node dist/…/worker.mjs schedule，Workers 为 Cron Triggers，Lambda 为 index.schedule。
 */
export default defineSchedule((s) => {
  s.call('heartbeat', () => {
    // 示例：替换为清理过期数据、生成报表等；onOneServer 保证多实例时只执行一次
  }).dailyAt('03:00').onOneServer()
})
