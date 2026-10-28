import { databaseProvider } from '@hazejs/orm'

// 注册数据库：读取 config/database.ts，Db / Model 自动使用该配置
export default databaseProvider()
