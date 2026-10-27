import type { ClientSession, Db, MongoClient } from 'mongodb'
import { AsyncLocalStorage } from 'node:async_hooks'
import { useDatabaseManager } from '../context'
import { DatabaseError } from '../errors'

export interface MongoSession {
  name: string
  db: Db
  client: MongoClient
  /** 处于 Mongo.transaction() 中时的会话 */
  session: ClientSession | undefined
}

/** 事务会话：连接名 → ClientSession（与 SQL 事务一样隐式传播） */
const sessions = new AsyncLocalStorage<Map<string, ClientSession>>()

export async function resolveMongo(connection?: string): Promise<MongoSession> {
  const resolved = await useDatabaseManager().connection(connection)
  if (resolved.dialect !== 'mongodb')
    throw new DatabaseError(`Connection "${resolved.name}" uses driver "${resolved.driver}", not mongodb`)
  return {
    name: resolved.name,
    db: resolved.db as Db,
    client: resolved.client as MongoClient,
    session: sessions.getStore()?.get(resolved.name),
  }
}

/**
 * MongoDB 事务（需要副本集或分片集群）。回调内的 Mongo / MongoModel 操作自动加入事务；
 * MongoDB 不支持嵌套事务，嵌套调用直接复用外层事务。
 */
export async function mongoTransaction<R>(callback: (session: ClientSession) => Promise<R>, connection?: string): Promise<R> {
  const mongo = await resolveMongo(connection)
  if (mongo.session)
    return callback(mongo.session)

  const session = mongo.client.startSession()
  try {
    let result!: R
    await session.withTransaction(async () => {
      result = await sessions.run(new Map(sessions.getStore()).set(mongo.name, session), () => callback(session))
    })
    return result
  }
  finally {
    await session.endSession()
  }
}
