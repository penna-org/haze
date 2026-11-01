import bcrypt from 'bcryptjs'
import { sql } from 'drizzle-orm'
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { DatabaseManager, Db, Model, modelUserProvider, setDatabaseManager } from '../src'

const users = sqliteTable('users', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  email: text('email').notNull(),
  password: text('password').notNull(),
})

class User extends Model.define(users) {}

describe('modelUserProvider', () => {
  let manager: DatabaseManager

  beforeEach(async () => {
    manager = new DatabaseManager({
      default: 'main',
      connections: {
        main: { driver: 'sqlite', url: ':memory:' },
      },
    })
    setDatabaseManager(manager)
    await manager.close()
    await Db.execute(sql`create table users (id integer primary key autoincrement, email text not null, password text not null)`)
  })

  afterAll(async () => {
    await manager.close()
  })

  async function migratedUser(): Promise<User> {
    await Db.table(users).insert({ email: 'ada@example.com', password: await bcrypt.hash('secret', 4) })
    return (await User.where('email', 'ada@example.com').find())!
  }

  it('rehashes a migrated bcrypt password after a successful login', async () => {
    const provider = modelUserProvider(() => User)
    const user = await migratedUser()
    const before = user.password

    expect(await provider.validateCredentials(user, { email: 'ada@example.com', password: 'wrong' })).toBe(false)
    expect((await User.find(user.id))!.password).toBe(before)

    expect(await provider.validateCredentials(user, { email: 'ada@example.com', password: 'secret' })).toBe(true)
    const stored = (await User.find(user.id))!.password
    expect(stored).toMatch(/^\$scrypt\$/)
    // 之后用新哈希登录，不再重新哈希
    const again = (await User.find(user.id))!
    expect(await provider.validateCredentials(again, { email: 'ada@example.com', password: 'secret' })).toBe(true)
    expect((await User.find(user.id))!.password).toBe(stored)
  })

  it('keeps the stored hash with rehash: false', async () => {
    const provider = modelUserProvider(() => User, { rehash: false })
    const user = await migratedUser()
    const before = user.password
    expect(await provider.validateCredentials(user, { email: 'ada@example.com', password: 'secret' })).toBe(true)
    expect((await User.find(user.id))!.password).toBe(before)
  })
})
