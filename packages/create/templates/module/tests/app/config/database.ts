import { defineDatabaseConfig } from '@hazejs/orm'

// 每个用例前 refreshDatabase() 重建内存库并执行模块的迁移
export default defineDatabaseConfig({
  default: 'main',
  connections: {
    main: { driver: 'sqlite', url: ':memory:' },
  },
})
