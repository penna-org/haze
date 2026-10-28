import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

// 认证扩展的表结构（haze make:auth-tables 生成后删去了两步验证与通行密钥两张表）
// 此文件只依赖 drizzle-orm，不要使用 ~ 别名（drizzle-kit 需要直接读取）
// JS 属性名由 @hazejs/orm 的 database*Store() 读取，请勿修改

// 个人访问令牌（config/auth.ts 的 token Guard）
export const personalAccessTokens = sqliteTable('personal_access_tokens', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  tokenableType: text('tokenable_type').notNull(),
  tokenableId: text('tokenable_id').notNull(),
  name: text('name').notNull(),
  // 明文令牌的 SHA-256 摘要
  token: text('token').notNull().unique(),
  abilities: text('abilities', { mode: 'json' }).$type<string[]>().notNull(),
  lastUsedAt: integer('last_used_at', { mode: 'timestamp_ms' }),
  expiresAt: integer('expires_at', { mode: 'timestamp_ms' }),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
}, table => [
  index('personal_access_tokens_tokenable_index').on(table.tokenableType, table.tokenableId),
])

// 找回密码的重置令牌（每个邮箱一条）
export const passwordResetTokens = sqliteTable('password_reset_tokens', {
  email: text('email').primaryKey(),
  // 重置令牌的 SHA-256 摘要
  token: text('token').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
})
