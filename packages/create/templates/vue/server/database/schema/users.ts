import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

// 表结构定义（drizzle）：此文件只依赖 drizzle-orm，不要使用 ~ 别名（drizzle-kit 需要直接读取）
// 修改后运行 think-h3 db:generate 生成迁移，再 think-h3 db:migrate
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
  createdAt: integer('created_at', { mode: 'timestamp' }),
  updatedAt: integer('updated_at', { mode: 'timestamp' }),
})
