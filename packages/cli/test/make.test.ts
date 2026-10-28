import type { KindName } from '../src/make/generator'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { KINDS, make, makeModel } from '../src/make/generator'
import { camelCase, commandName, kebabCase, parseName, plural } from '../src/make/naming'

const root = fileURLToPath(new URL(`./.tmp/make-${process.pid}`, import.meta.url))
const srcDir = join(root, 'server')

afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('naming', () => {
  it('parses names with directories and strips type suffixes', () => {
    expect(parseName('User', 'Controller')).toEqual({ dir: '', name: 'User' })
    expect(parseName('UserController', 'Controller')).toEqual({ dir: '', name: 'User' })
    expect(parseName('Admin/user-profile', 'Controller')).toEqual({ dir: 'admin', name: 'UserProfile' })
    expect(parseName('admin\\billing/Invoice')).toEqual({ dir: 'admin/billing', name: 'Invoice' })
    expect(() => parseName('123abc')).toThrow(/Invalid name/)
  })

  it('derives console command names from the file path', () => {
    expect(commandName('', 'SendReport')).toBe('send:report')
    expect(commandName('', 'SendDailyReportCommand')).toBe('send:daily-report')
    expect(commandName('', 'Inspire')).toBe('inspire')
    expect(commandName('db', 'Cleanup')).toBe('db:cleanup')
    expect(commandName('db/maintenance', 'PruneOld')).toBe('db:maintenance:prune-old')
  })

  it('converts cases and pluralizes', () => {
    expect(camelCase('UserProfile')).toBe('userProfile')
    expect(kebabCase('UserProfile')).toBe('user-profile')
    expect(['user', 'box', 'category', 'day'].map(plural)).toEqual(['users', 'boxes', 'categories', 'days'])
  })
})

describe('make', () => {
  const rel = (file: string): string => relative(root, file)

  it('places every kind in its conventional location', async () => {
    const expected: Record<KindName, string> = {
      controller: 'server/app/controller/admin/UserProfileController.ts',
      service: 'server/app/service/admin/UserProfileService.ts',
      repository: 'server/app/repository/admin/UserProfileRepository.ts',
      middleware: 'server/app/middleware/admin/UserProfile.ts',
      interceptor: 'server/app/interceptor/user-profile.ts',
      provider: 'server/app/provider/admin/UserProfileProvider.ts',
      policy: 'server/app/policy/UserProfilePolicy.ts',
      job: 'server/app/job/UserProfile.ts',
      event: 'server/app/event/UserProfile.ts',
      listener: 'server/app/listener/UserProfile.ts',
      validate: 'server/app/validate/admin/user-profile.ts',
      test: 'tests/admin/user-profile.test.ts',
      config: 'server/config/userProfile.ts',
      route: 'server/route/user-profile.ts',
      seeder: 'server/database/seeders/user-profile.ts',
      command: 'server/app/command/admin/UserProfile.ts',
      mail: 'server/app/mail/admin/UserProfileMail.ts',
    }
    for (const kind of Object.keys(KINDS) as KindName[]) {
      // config / route 只按第一层自动发现，不带子目录
      const name = kind === 'config' || kind === 'route' || kind === 'interceptor' || kind === 'seeder' || kind === 'policy' || kind === 'job' || kind === 'event' || kind === 'listener'
        ? 'user-profile'
        : 'admin/user-profile'
      const result = await make({ root, srcDir, kind, name })
      expect(rel(result.file), kind).toBe(expected[kind])
      expect(readFileSync(result.file, 'utf8'), kind).not.toMatch(/\{\{\s*\w+\s*\}\}/)
    }
  })

  it('renders the resource controller with route hints', async () => {
    const result = await make({
      root,
      srcDir,
      kind: 'controller',
      name: 'Category',
      variant: 'controller.resource',
    })
    const content = readFileSync(result.file, 'utf8')
    expect(content).toContain('export class CategoryController')
    expect(content).toContain(`r.resource('/categories', CategoryController)`)
    expect(content).toContain('destroy(ctx: HttpContext)')
    expect(result.hint).toContain('CategoryController')
  })

  it('rejects subdirectories for auto-discovered config and route files', async () => {
    await expect(make({
      root,
      srcDir,
      kind: 'config',
      name: 'admin/mail',
    })).rejects.toThrow(/不能包含子目录/)
    await expect(make({
      root,
      srcDir,
      kind: 'route',
      name: 'admin/users',
    })).rejects.toThrow(/不能包含子目录/)
  })

  it('generates console commands and mails', async () => {
    const command = await make({
      root,
      srcDir,
      kind: 'command',
      name: 'db/PruneOld',
    })
    expect(rel(command.file)).toBe('server/app/command/db/PruneOld.ts')
    expect(readFileSync(command.file, 'utf8')).toContain('haze db:prune-old')
    expect(command.hint).toContain('haze db:prune-old')
    await expect(make({
      root,
      srcDir,
      kind: 'command',
      name: 'Report',
      app: 'admin',
    })).rejects.toThrow(/--app/)

    const mail = await make({
      root,
      srcDir,
      kind: 'mail',
      name: 'Invoice',
    })
    expect(rel(mail.file)).toBe('server/app/mail/InvoiceMail.ts')
    const source = readFileSync(mail.file, 'utf8')
    expect(source).toContain('export default defineMail((payload: InvoiceMailPayload)')
    expect(source).toContain(`{ name: 'InvoiceMail' }`)
    expect(mail.hint).toContain('send(InvoiceMail')
  })

  it('generates into an app directory with --app', async () => {
    const results = [
      await make({
        root,
        srcDir,
        kind: 'controller',
        name: 'User',
        app: 'admin',
      }),
      await make({
        root,
        srcDir,
        kind: 'route',
        name: 'web',
        app: 'admin',
      }),
      await make({
        root,
        srcDir,
        kind: 'config',
        name: 'app',
        app: 'admin',
      }),
      await make({
        root,
        srcDir,
        kind: 'test',
        name: 'admin-user',
        app: 'admin',
      }),
    ]
    expect(results.map(result => rel(result.file))).toEqual([
      'server/app/admin/controller/UserController.ts',
      'server/app/admin/route/web.ts',
      'server/app/admin/config/app.ts',
      'tests/admin-user.test.ts',
    ])
  })

  it('generates a model with its drizzle schema per dialect', async () => {
    const result = await makeModel({
      root,
      srcDir,
      name: 'OrderItem',
      softDelete: true,
    })
    expect(rel(result.model)).toBe('server/app/model/OrderItem.ts')
    expect(rel(result.schema!)).toBe('server/database/schema/order_items.ts')
    const model = readFileSync(result.model, 'utf8')
    expect(model).toContain(`import { orderItems } from '~/database/schema/order_items'`)
    expect(model).toContain('export class OrderItem extends Model.define(orderItems)')
    expect(model).toContain('static override softDelete = true')
    expect(readFileSync(result.schema!, 'utf8')).toContain(`sqliteTable('order_items'`)

    // 表结构已存在时只生成模型
    const again = await makeModel({
      root,
      srcDir,
      name: 'Admin/OrderItem',
      dialect: 'mysql',
      app: 'admin',
    })
    expect(rel(again.model)).toBe('server/app/admin/model/admin/OrderItem.ts')
    expect(again.schema).toBeUndefined()

    const pg = await makeModel({
      root,
      srcDir,
      name: 'Category',
      dialect: 'postgres',
    })
    expect(readFileSync(pg.schema!, 'utf8')).toContain(`pgTable('categories'`)

    // MongoDB：只生成模型（含文档接口），没有表结构文件
    const mongo = await makeModel({
      root,
      srcDir,
      name: 'Article',
      dialect: 'mongodb',
    })
    expect(mongo.schema).toBeUndefined()
    const source = readFileSync(mongo.model, 'utf8')
    expect(source).toContain('export interface ArticleDoc')
    expect(source).toContain(`export class Article extends MongoModel.define<ArticleDoc>('articles')`)
  })

  it('refuses to overwrite unless forced', async () => {
    await make({
      root,
      srcDir,
      kind: 'service',
      name: 'Order',
    })
    await expect(make({
      root,
      srcDir,
      kind: 'service',
      name: 'OrderService',
    })).rejects.toThrow(/already exists/)
    await expect(make({
      root,
      srcDir,
      kind: 'service',
      name: 'Order',
      force: true,
    })).resolves.toBeDefined()
  })

  it('prefers project stubs over built-in ones', async () => {
    mkdirSync(join(root, 'stubs'), { recursive: true })
    writeFileSync(join(root, 'stubs', 'service.stub'), '// team stub for {{ className }} ({{kebabName}})\n')
    const result = await make({
      root,
      srcDir,
      kind: 'service',
      name: 'Payment',
    })
    expect(result.custom).toBe(true)
    expect(readFileSync(result.file, 'utf8')).toBe('// team stub for PaymentService (payment)\n')
  })
})
