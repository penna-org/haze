import type { ConnectionConfig } from '../src'
import { sql } from 'drizzle-orm'
import { boolean, index, jsonb, integer as pgInt, primaryKey as pgPrimaryKey, pgTable, text as pgText, serial, timestamp } from 'drizzle-orm/pg-core'
import { integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { DatabaseManager, databasePasskeyStore, databasePasswordResetStore, databaseTokenStore, databaseTwoFactorStore, Db, setDatabaseManager } from '../src'

// 与 haze make:auth-tables 生成的表结构一致（packages/cli/stubs/auth-tables.*.stub）

const sqlite = {
  personalAccessTokens: sqliteTable('personal_access_tokens', {
    id: integer('id').primaryKey({ autoIncrement: true }),
    tokenableType: text('tokenable_type').notNull(),
    tokenableId: text('tokenable_id').notNull(),
    name: text('name').notNull(),
    token: text('token').notNull().unique(),
    abilities: text('abilities', { mode: 'json' }).$type<string[]>().notNull(),
    lastUsedAt: integer('last_used_at', { mode: 'timestamp_ms' }),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  }),
  passwordResetTokens: sqliteTable('password_reset_tokens', {
    email: text('email').primaryKey(),
    token: text('token').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  }),
  twoFactorSecrets: sqliteTable('two_factor_secrets', {
    userType: text('user_type').notNull(),
    userId: text('user_id').notNull(),
    secret: text('secret').notNull(),
    recoveryCodes: text('recovery_codes', { mode: 'json' }).$type<string[]>().notNull(),
    confirmedAt: integer('confirmed_at', { mode: 'timestamp_ms' }),
    lastUsedStep: integer('last_used_step'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  }, table => [
    primaryKey({
      columns: [table.userType, table.userId],
    }),
  ]),
  webauthnCredentials: sqliteTable('webauthn_credentials', {
    id: text('id').primaryKey(),
    userType: text('user_type').notNull(),
    userId: text('user_id').notNull(),
    name: text('name'),
    publicKey: text('public_key').notNull(),
    counter: integer('counter').notNull().default(0),
    transports: text('transports', { mode: 'json' }).$type<string[]>().notNull(),
    deviceType: text('device_type').notNull(),
    backedUp: integer('backed_up', { mode: 'boolean' }).notNull().default(false),
    aaguid: text('aaguid'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    lastUsedAt: integer('last_used_at', { mode: 'timestamp_ms' }),
  }),
}

const postgres = {
  personalAccessTokens: pgTable('personal_access_tokens', {
    id: serial('id').primaryKey(),
    tokenableType: pgText('tokenable_type').notNull(),
    tokenableId: pgText('tokenable_id').notNull(),
    name: pgText('name').notNull(),
    token: pgText('token').notNull().unique(),
    abilities: jsonb('abilities').$type<string[]>().notNull(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  }, table => [
    index('pat_tokenable').on(table.tokenableType, table.tokenableId),
  ]),
  passwordResetTokens: pgTable('password_reset_tokens', {
    email: pgText('email').primaryKey(),
    token: pgText('token').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  }),
  twoFactorSecrets: pgTable('two_factor_secrets', {
    userType: pgText('user_type').notNull(),
    userId: pgText('user_id').notNull(),
    secret: pgText('secret').notNull(),
    recoveryCodes: jsonb('recovery_codes').$type<string[]>().notNull(),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    lastUsedStep: pgInt('last_used_step'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  }, table => [
    pgPrimaryKey({
      columns: [table.userType, table.userId],
    }),
  ]),
  webauthnCredentials: pgTable('webauthn_credentials', {
    id: pgText('id').primaryKey(),
    userType: pgText('user_type').notNull(),
    userId: pgText('user_id').notNull(),
    name: pgText('name'),
    publicKey: pgText('public_key').notNull(),
    counter: pgInt('counter').notNull().default(0),
    transports: jsonb('transports').$type<string[]>().notNull(),
    deviceType: pgText('device_type').notNull(),
    backedUp: boolean('backed_up').notNull().default(false),
    aaguid: pgText('aaguid'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  }),
}

const ddl = {
  sqlite: [
    'create table personal_access_tokens (id integer primary key autoincrement, tokenable_type text not null, tokenable_id text not null, name text not null, token text not null unique, abilities text not null, last_used_at integer, expires_at integer, created_at integer not null)',
    'create table password_reset_tokens (email text primary key, token text not null, created_at integer not null)',
    'create table two_factor_secrets (user_type text not null, user_id text not null, secret text not null, recovery_codes text not null, confirmed_at integer, last_used_step integer, created_at integer not null, primary key (user_type, user_id))',
    'create table webauthn_credentials (id text primary key, user_type text not null, user_id text not null, name text, public_key text not null, counter integer not null default 0, transports text not null, device_type text not null, backed_up integer not null default 0, aaguid text, created_at integer not null, last_used_at integer)',
  ],
  postgres: [
    'create table personal_access_tokens (id serial primary key, tokenable_type text not null, tokenable_id text not null, name text not null, token text not null unique, abilities jsonb not null, last_used_at timestamptz, expires_at timestamptz, created_at timestamptz not null)',
    'create table password_reset_tokens (email text primary key, token text not null, created_at timestamptz not null)',
    'create table two_factor_secrets (user_type text not null, user_id text not null, secret text not null, recovery_codes jsonb not null, confirmed_at timestamptz, last_used_step integer, created_at timestamptz not null, primary key (user_type, user_id))',
    'create table webauthn_credentials (id text primary key, user_type text not null, user_id text not null, name text, public_key text not null, counter integer not null default 0, transports jsonb not null, device_type text not null, backed_up boolean not null default false, aaguid text, created_at timestamptz not null, last_used_at timestamptz)',
  ],
}

const dialects: Array<{ name: string, connection: ConnectionConfig, schema: typeof sqlite, ddl: string[] }> = [
  {
    name: 'sqlite',
    connection: { driver: 'sqlite', url: ':memory:' },
    schema: sqlite,
    ddl: ddl.sqlite,
  },
  {
    name: 'pglite',
    connection: { driver: 'pglite' },
    schema: postgres as unknown as typeof sqlite,
    ddl: ddl.postgres,
  },
]

describe.each(dialects)('auth stores on $name', (dialect) => {
  let manager: DatabaseManager

  beforeEach(async () => {
    manager = new DatabaseManager({
      default: 'main',
      connections: { main: dialect.connection },
    })
    setDatabaseManager(manager)
    await manager.close()
    for (const statement of dialect.ddl)
      await Db.execute(sql.raw(statement))
  })

  afterAll(async () => {
    await manager.close()
  })

  it('stores personal access tokens', async () => {
    const store = databaseTokenStore(dialect.schema.personalAccessTokens)
    const created = await store.create({
      tokenableType: 'users',
      tokenableId: '1',
      name: 'cli',
      token: 'a'.repeat(64),
      abilities: ['posts:read'],
      lastUsedAt: null,
      expiresAt: new Date('2030-01-01T00:00:00Z'),
      createdAt: new Date(),
    })
    expect(created.id).toBe(1)
    const { id: _id, ...base } = created
    await store.create({
      ...base,
      token: 'b'.repeat(64),
      name: 'ci',
    })
    await store.create({
      ...base,
      token: 'c'.repeat(64),
      tokenableId: '2',
    })

    const found = await store.find('1')
    expect(found).toMatchObject({
      name: 'cli',
      abilities: ['posts:read'],
      tokenableId: '1',
    })
    expect(found!.expiresAt!.toISOString()).toBe('2030-01-01T00:00:00.000Z')
    const used = new Date()
    await store.update('1', { lastUsedAt: used })
    expect((await store.find('1'))!.lastUsedAt!.getTime()).toBe(used.getTime())
    expect((await store.list('users', '1')).map(token => token.name)).toEqual(['cli', 'ci'])
    expect(await store.delete('1')).toBe(true)
    expect(await store.delete('1')).toBe(false)
    expect(await store.find('nope')).toBeUndefined()
    expect(await store.deleteAll('users', '1')).toBe(1)
    expect(await store.list('users', '2')).toHaveLength(1)
  })

  it('stores password reset tokens (one per email)', async () => {
    const store = databasePasswordResetStore(() => dialect.schema.passwordResetTokens)
    const createdAt = new Date()
    await store.put('ada@example.com', { token: 'one', createdAt }, 3600)
    await store.put('ada@example.com', { token: 'two', createdAt }, 3600)
    expect(await store.get('ada@example.com')).toEqual({ token: 'two', createdAt })
    await store.delete('ada@example.com')
    expect(await store.get('ada@example.com')).toBeUndefined()
  })

  it('stores two-factor secrets', async () => {
    const store = databaseTwoFactorStore(dialect.schema.twoFactorSecrets)
    expect(await store.get('users', '1')).toBeUndefined()
    await store.set('users', '1', {
      secret: 'v1.x',
      recoveryCodes: ['h1', 'h2'],
      confirmedAt: null,
      lastUsedStep: null,
    })
    const confirmedAt = new Date()
    await store.set('users', '1', {
      secret: 'v1.x',
      recoveryCodes: ['h2'],
      confirmedAt,
      lastUsedStep: 58_000_000,
    })
    expect(await store.get('users', '1')).toEqual({
      secret: 'v1.x',
      recoveryCodes: ['h2'],
      confirmedAt,
      lastUsedStep: 58_000_000,
    })
    expect(await store.get('admins', '1')).toBeUndefined()
    await store.delete('users', '1')
    expect(await store.get('users', '1')).toBeUndefined()
  })

  it('stores webauthn credentials', async () => {
    const store = databasePasskeyStore(dialect.schema.webauthnCredentials)
    const credential = {
      id: 'Y3JlZGVudGlhbA',
      userType: 'users',
      userId: '1',
      name: 'Laptop',
      publicKey: 'cHVibGlj',
      counter: 0,
      transports: ['internal', 'hybrid'],
      deviceType: 'multiDevice' as const,
      backedUp: true,
      aaguid: '00000000-0000-0000-0000-000000000000',
      createdAt: new Date(),
      lastUsedAt: null,
    }
    await store.create(credential)
    expect(await store.find(credential.id)).toEqual(credential)
    await store.update(credential.id, { counter: 5, lastUsedAt: credential.createdAt, backedUp: false })
    expect(await store.find(credential.id)).toMatchObject({ counter: 5, backedUp: false })
    expect(await store.list('users', '1')).toHaveLength(1)
    expect(await store.delete(credential.id)).toBe(true)
    expect(await store.list('users', '1')).toEqual([])
  })
})
