import { env } from '@hazejs/core'
import { defineDatabaseConfig } from '@hazejs/orm'

/**
 * 数据库连接。driver：sqlite（libsql）| turso（HTTP）| d1（Cloudflare）| postgres | pglite | mysql
 * 切换数据库：安装对应驱动（postgres / mysql2），修改 driver 与 url，并改用对应方言的表结构。
 */
export default defineDatabaseConfig(() => ({
  default: 'main',
  connections: {
    main: {
      driver: 'sqlite',
      url: env('DATABASE_URL', 'file:./data/app.db'),
      logging: env('DB_LOGGING', false),
    },
  },
}))
