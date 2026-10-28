import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

// 表结构定义（drizzle）：此文件只依赖 drizzle-orm，不要使用 ~ 别名（drizzle-kit 需要直接读取）
// 修改后运行 haze db:generate 生成迁移，再 haze db:migrate
export const users = sqliteTable('users', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  // 密码哈希（Hash.make()），通过 /api/auth/register 注册的用户才有
  password: text('password'),
  // 角色：admin 可以管理所有用户（app/policy/UserPolicy.ts）
  role: text('role', {
    enum: ['member', 'admin'],
  }).notNull().default('member'),
  // 邮箱验证时间（/api/auth/email/verify 写入），为空表示未验证；verified 中间件据此拦截
  emailVerifiedAt: integer('email_verified_at', { mode: 'timestamp' }),
  createdAt: integer('created_at', { mode: 'timestamp' }),
  updatedAt: integer('updated_at', { mode: 'timestamp' }),
})
