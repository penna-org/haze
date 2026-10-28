import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

// 模块自己的表（加上模块前缀，避免与宿主项目的表重名）。修改后运行 pnpm db:generate 生成迁移
export const posts = sqliteTable('{{moduleTable}}_posts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  title: text('title').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }),
})
