import type { ClientSession, Db, Document } from 'mongodb'
import { mongoTransaction, resolveMongo } from './context'
import { MongoQuery } from './query'

export { mongoTransaction, resolveMongo } from './context'
export type { MongoSession } from './context'
export { hydrateMongoModel, metaOfMongo, MongoModel } from './model'
export type { DefinedMongoModel, DocOf, MongoModelClass, MongoModelMeta, MongoModelSettings } from './model'
export { MongoModelQuery, MongoQuery, toObjectId } from './query'
export type { MongoQueryOptions, MongoWhere } from './query'
export { ObjectId } from 'mongodb'

export interface ScopedMongo {
  /** 集合查询构造器：`Mongo.collection<UserDoc>('users').where('status', 1).select()` */
  collection: <T extends Document = Document>(name: string) => MongoQuery<T>
  /** 事务（需要副本集）：回调内的 Mongo / MongoModel 操作自动加入事务 */
  transaction: <R>(callback: (session: ClientSession) => Promise<R>) => Promise<R>
  /** 底层 mongodb Db 实例（索引管理、变更流等） */
  db: () => Promise<Db>
}

function scoped(connection?: string): ScopedMongo {
  return {
    collection: <T extends Document = Document>(name: string) => new MongoQuery<T>(name, { connection }),
    transaction: callback => mongoTransaction(callback, connection),
    db: async () => (await resolveMongo(connection)).db,
  }
}

/** MongoDB 门面：默认连接的快捷入口，`Mongo.connection(name)` 切换连接 */
export const Mongo = {
  ...scoped(),
  connection: (name: string): ScopedMongo => scoped(name),
}
