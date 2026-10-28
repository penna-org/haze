import type { Application } from '@hazejs/core'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApplication, defineRoutes, Tenancy, tenancy } from '@hazejs/core'
import { sql } from 'drizzle-orm'
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { databaseProvider, Db, Model, useDatabaseManager } from '../src'

const projects = sqliteTable('projects', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  tenantId: text('tenant_id'),
  name: text('name').notNull(),
  status: integer('status').notNull().default(1),
})

const notes = sqliteTable('notes', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  body: text('body').notNull(),
})

class Project extends Model.define(projects) {
  static override belongsToTenant = true
}

class Note extends Model.define(notes) {
  static override connection = 'tenant'
}

const tenants: Record<string, { id: string }> = {
  acme: { id: 'acme' },
  globex: { id: 'globex' },
}

let dir: string
let app: Application | undefined

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'haze-tenancy-'))
})

afterEach(async () => {
  await useDatabaseManager().close()
  await app?.dispose()
  app = undefined
})

afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function boot(tenancyConfig: Record<string, unknown> = {}): Promise<Application> {
  app = await createApplication({
    mode: 'test',
    env: false,
    providers: [
      databaseProvider(),
    ],
    routes: [
      defineRoutes((r) => {
        r.get('/projects', async () => (await Project.order('id').select()).map(project => project.name))
        r.post('/projects', async ctx => Project.create({ name: (await ctx.body<{ name: string }>()).name }))
      }),
    ],
    config: {
      logger: { level: 'silent' },
      middleware: {
        global: [tenancy],
      },
      database: {
        default: 'main',
        connections: {
          main: { driver: 'sqlite', url: ':memory:' },
          tenant: { driver: 'sqlite', url: `file:${join(dir, 'template.db')}` },
        },
      },
      tenancy: {
        find: (key: string) => tenants[key],
        ...tenancyConfig,
      },
    },
  })
  return app
}

describe('single database with a tenant id column (belongsToTenant)', () => {
  it('fills the tenant id on create and filters every query by the current tenant', async () => {
    await boot()
    await Db.execute(sql`create table projects (id integer primary key autoincrement, tenant_id text, name text not null, status integer not null default 1)`)

    const created = await Tenancy.run('acme', () => Project.create({ name: 'Rocket' }))
    expect(created.tenantId).toBe('acme')
    await Tenancy.run('acme', () => Project.create({ name: 'Anvil' }))
    await Tenancy.run('globex', () => Project.create({ name: 'Hammock' }))
    // 显式指定的租户 ID 不被覆盖（中央上下文的管理操作）
    await Project.create({ name: 'Shared', tenantId: 'globex' })

    expect((await Tenancy.run('acme', () => Project.order('id').column('name')))).toEqual(['Rocket', 'Anvil'])
    expect((await Tenancy.run('globex', () => Project.order('id').column('name')))).toEqual(['Hammock', 'Shared'])
    // 中央上下文（没有租户）不过滤
    expect(await Project.count()).toBe(4)
    // 跨租户按主键查询查不到
    expect(await Tenancy.run('globex', () => Project.find(created.id))).toBeUndefined()
    // 关闭全局作用域
    expect(await Tenancy.run('globex', () => Project.withoutGlobalScope(['tenant']).count())).toBe(4)
    expect(await Tenancy.run('globex', () => Project.withoutGlobalScope().count())).toBe(4)

    // 批量更新 / 删除同样只作用于当前租户
    expect(await Tenancy.run('acme', () => Project.where('status', 1).update({ status: 2 }))).toBe(2)
    expect(await Project.where('status', 2).count()).toBe(2)
    expect(await Tenancy.run('globex', () => Project.query().delete({ all: true }))).toBe(2)
    expect(await Project.order('id').column('name')).toEqual(['Rocket', 'Anvil'])
  })

  it('scopes models in requests resolved by the tenancy middleware', async () => {
    const app = await boot()
    await Db.execute(sql`create table projects (id integer primary key autoincrement, tenant_id text, name text not null, status integer not null default 1)`)
    const post = (tenant: string, name: string): Promise<Response> => app.request('/projects', {
      method: 'POST',
      headers: { 'x-tenant': tenant, 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    })
    await post('acme', 'A1')
    await post('globex', 'G1')
    await post('acme', 'A2')
    const list = async (tenant: string): Promise<unknown> => (await (await app.request('/projects', {
      headers: { 'x-tenant': tenant },
    })).json() as { data: unknown }).data
    expect(await list('acme')).toEqual(['A1', 'A2'])
    expect(await list('globex')).toEqual(['G1'])
  })
})

describe('database per tenant', () => {
  const config = {
    database: {
      connections: ['tenant'],
      config: (tenant: { id: string | number }, base: Record<string, unknown>) => ({ ...base, url: `file:${join(dir, `${tenant.id}.db`)}` }),
    },
  }

  it('switches the connection to the tenant database and caches one connection per tenant', async () => {
    await boot(config)
    for (const key of ['acme', 'globex']) {
      await Tenancy.run(key, async () => {
        await Db.connection('tenant').execute(sql`create table if not exists notes (id integer primary key autoincrement, body text not null)`)
        await Note.create({ body: `hello ${key}` })
      })
    }
    await Tenancy.run('acme', () => Note.create({ body: 'second acme' }))

    expect(existsSync(join(dir, 'acme.db'))).toBe(true)
    expect(existsSync(join(dir, 'globex.db'))).toBe(true)
    expect(await Tenancy.run('acme', () => Note.order('id').column('body'))).toEqual(['hello acme', 'second acme'])
    expect(await Tenancy.run('globex', () => Note.order('id').column('body'))).toEqual(['hello globex'])

    const manager = useDatabaseManager()
    expect(await Tenancy.run('acme', () => manager.resolveName('tenant'))).toBe('tenant@acme')
    // 不在 connections 中的连接（中央库）不切换
    expect(await Tenancy.run('acme', () => manager.resolveName('main'))).toBe('main')
    const first = await Tenancy.run('acme', () => manager.connection('tenant'))
    expect(await Tenancy.run('acme', () => manager.connection('tenant'))).toBe(first)
    expect(first.name).toBe('tenant@acme')
  })

  it('keeps transactions on the tenant connection', async () => {
    await boot(config)
    await Tenancy.run('globex', async () => {
      await Db.connection('tenant').execute(sql`create table if not exists notes (id integer primary key autoincrement, body text not null)`)
      await Db.connection('tenant').execute(sql`delete from notes`)
      await expect(Note.transaction(async () => {
        await Note.create({ body: 'rolled back' })
        throw new Error('boom')
      })).rejects.toThrow('boom')

      await Db.connection('tenant').startTrans()
      await Note.create({ body: 'committed' })
      expect(Db.connection('tenant').inTransaction()).toBe(true)
      await Db.connection('tenant').commit()
      expect(await Note.query().column('body')).toEqual(['committed'])
    })
    // 另一个租户的数据库不受影响
    expect(await Tenancy.run('acme', () => Note.where('body', 'committed').count())).toBe(0)
  })
})
