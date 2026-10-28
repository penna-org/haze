import { defineEvent } from '../events/event'

/**
 * 认证相关的内置事件（监听：`defineListener(EmailVerified, ({ user }) => ...)`）。
 * 排队执行的监听器收到的 user 为 JSON 序列化后的对象，需要模型时请按 id 重新查询。
 */

/** 邮箱验证完成 */
export const EmailVerified = defineEvent<{ user: unknown, id: string }>({ name: 'auth:email-verified' })

/** 已发送重置密码链接 */
export const PasswordResetLinkSent = defineEvent<{ user: unknown, id: string, email: string }>({ name: 'auth:password-reset-link-sent' })

/** 密码已通过重置链接修改 */
export const PasswordResetCompleted = defineEvent<{ user: unknown, id: string, email: string }>({ name: 'auth:password-reset' })

/** 启用（确认）两步验证 */
export const TwoFactorEnabled = defineEvent<{ user: unknown, id: string }>({ name: 'auth:two-factor-enabled' })

/** 关闭两步验证 */
export const TwoFactorDisabled = defineEvent<{ user: unknown, id: string }>({ name: 'auth:two-factor-disabled' })

/** 两步验证码或恢复码校验失败（可用于告警 / 锁定） */
export const TwoFactorFailed = defineEvent<{ user: unknown, id: string }>({ name: 'auth:two-factor-failed' })
