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

const owners = sqliteTable('owners', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
})

const tasks = sqliteTable('tasks', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  projectId: integer('project_id').notNull(),
  title: text('title').notNull(),
})

class Task extends Model.define(tasks) {}

class Owner extends Model.define(owners) {
  /** 中间模型 Project 按租户隔离（这里借用 status 列保存负责人 ID） */
  tasks() {
    return this.hasManyThrough(Task, Project, 'status', 'projectId')
  }
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
    // 租户列不接受批量赋值；中央上下文的管理操作用 allowField 显式列出后才写入，且不被覆盖
    await Project.create({ name: 'Shared', tenantId: 'globex' }, ['name', 'tenantId'])

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

  it('ignores a mass-assigned tenant id and scopes the intermediate model of through relations', async () => {
    await boot()
    await Db.execute(sql`create table projects (id integer primary key autoincrement, tenant_id text, name text not null, status integer not null default 1)`)
    await Db.execute(sql`create table owners (id integer primary key autoincrement, name text not null)`)
    await Db.execute(sql`create table tasks (id integer primary key autoincrement, project_id integer not null, title text not null)`)

    // 请求数据中的 tenantId 被忽略：写入的仍是当前租户
    const spoofed = await Tenancy.run('acme', () => Project.create({ name: 'Rocket', tenantId: 'globex' }))
    expect(spoofed.tenantId).toBe('acme')
    await Tenancy.run('acme', () => spoofed.save({ tenantId: 'globex', name: 'Rocket 2' }))
    expect(await Db.table(projects).where('id', spoofed.id).value('tenantId')).toBe('acme')
    expect(spoofed.name).toBe('Rocket 2')
    // 没有租户上下文时同样忽略；forceFill / 直接赋值可以写
    expect((await Project.create({ name: 'Central', tenantId: 'globex' })).tenantId).toBeNull()
    const moved = new Project().forceFill({ name: 'Hammock', tenantId: 'globex' })
    await moved.save()
    expect(moved.tenantId).toBe('globex')

    // 远程一对多：中间模型（Project）按当前租户过滤
    const owner = await Owner.create({ name: 'Ada' })
    await Db.table(projects).where('id', spoofed.id).update({ status: owner.id })
    await Db.table(projects).where('id', moved.id).update({ status: owner.id })
    await Task.create({ projectId: spoofed.id, title: 'acme task' })
    await Task.create({ projectId: moved.id, title: 'globex task' })
    expect((await Tenancy.run('acme', () => owner.tasks())).map(task => task.title)).toEqual(['acme task'])
    expect((await Tenancy.run('globex', () => owner.tasks())).map(task => task.title)).toEqual(['globex task'])
    expect((await owner.tasks()).map(task => task.title).sort()).toEqual(['acme task', 'globex task'])
    expect(await Tenancy.run('acme', () => Owner.has('tasks').count())).toBe(1)
  })

  it('does not treat the tenant filter as a condition for bulk writes', async () => {
    await boot()
    await Db.execute(sql`create table projects (id integer primary key autoincrement, tenant_id text, name text not null, status integer not null default 1)`)
    await Tenancy.run('acme', () => Project.create({ name: 'Rocket' }))
    await Tenancy.run('acme', () => Project.create({ name: 'Anvil' }))
    await Tenancy.run('globex', () => Project.create({ name: 'Hammock' }))

    const refused = /Refusing to (update|delete) all rows of "projects" without conditions/
    await expect(Tenancy.run('acme', () => Project.query().update({ status: 2 }))).rejects.toThrow(refused)
    await expect(Tenancy.run('acme', () => Project.query().delete())).rejects.toThrow(refused)
    await expect(Tenancy.run('acme', () => Project.query().forceDelete())).rejects.toThrow(refused)
    expect(await Project.where('status', 2).count()).toBe(0)
    expect(await Project.count()).toBe(3)

    // 用户条件与 { all: true } 仍然只作用于当前租户
    expect(await Tenancy.run('acme', () => Project.where('name', 'Rocket').update({ status: 2 }))).toBe(1)
    expect(await Tenancy.run('acme', () => Project.query().update({ status: 3 }, { all: true }))).toBe(2)
    expect(await Project.where('status', 3).count()).toBe(2)
    expect(await Tenancy.run('acme', () => Project.query().delete({ all: true }))).toBe(2)
    expect(await Project.query().column('name')).toEqual(['Hammock'])
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
