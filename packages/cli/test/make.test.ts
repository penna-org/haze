import type { KindName } from '../src/make/generator'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { KINDS, make, makeAuthTables, makeModel, makeModule, makeNotificationsTable, makeQueueTables } from '../src/make/generator'
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
      notification: 'server/app/notification/UserProfileNotification.ts',
      channel: 'server/app/channel/user-profile.ts',
      resource: 'server/app/resource/admin/UserProfileResource.ts',
    }
    for (const kind of Object.keys(KINDS) as KindName[]) {
      // config / route 只按第一层自动发现，不带子目录
      const name = kind === 'config' || kind === 'route' || kind === 'interceptor' || kind === 'seeder' || kind === 'policy' || kind === 'job' || kind === 'event' || kind === 'listener' || kind === 'notification' || kind === 'channel'
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

  it('scaffolds a local module and generates into it with --module', async () => {
    const created = await makeModule({ root, srcDir, name: 'BlogModule' })
    expect(created.files.map(rel)).toEqual([
      'server/modules/blog/module.ts',
      'server/modules/blog/route/blog.ts',
      'server/modules/blog/app/controller/BlogController.ts',
      'server/modules/blog/config/blog.ts',
      'server/modules/blog/tests/blog.test.ts',
    ])
    for (const file of created.files)
      expect(readFileSync(file, 'utf8'), file).not.toMatch(/\{\{\s*\w+\s*\}\}/)
    expect(readFileSync(created.files[0], 'utf8')).toContain(`prefix: '/api/blog'`)
    await expect(makeModule({ root, srcDir, name: 'blog' })).rejects.toThrow(/already exists/)

    const results = await Promise.all([
      make({
        root,
        srcDir,
        kind: 'controller',
        name: 'Post',
        module: 'blog',
      }),
      make({
        root,
        srcDir,
        kind: 'middleware',
        name: 'EnsureAuthor',
        module: 'blog',
      }),
      make({
        root,
        srcDir,
        kind: 'job',
        name: 'SendDigest',
        module: 'blog',
      }),
      make({
        root,
        srcDir,
        kind: 'command',
        name: 'db/Prune',
        module: 'blog',
      }),
      make({
        root,
        srcDir,
        kind: 'config',
        name: 'feed',
        module: 'blog',
      }),
      make({
        root,
        srcDir,
        kind: 'seeder',
        name: 'posts',
        module: 'blog',
      }),
      make({
        root,
        srcDir,
        kind: 'test',
        name: 'posts',
        module: 'blog',
      }),
    ])
    expect(results.map(result => rel(result.file))).toEqual([
      'server/modules/blog/app/controller/PostController.ts',
      'server/modules/blog/app/middleware/EnsureAuthor.ts',
      'server/modules/blog/app/job/SendDigest.ts',
      'server/modules/blog/app/command/db/Prune.ts',
      'server/modules/blog/config/feed.ts',
      'server/modules/blog/database/seeders/posts.ts',
      'server/modules/blog/tests/posts.test.ts',
    ])
    // 提示中的目录指向模块
    expect(results[0].hint).toContain('modules/blog/route/*.ts')
    expect(results[1].hint).toContain('modules/blog/config/middleware.ts')

    const model = await makeModel({
      root,
      srcDir,
      name: 'Post',
      module: 'blog',
    })
    expect([
      rel(model.model),
      rel(model.schema!),
    ]).toEqual([
      'server/modules/blog/app/model/Post.ts',
      'server/modules/blog/database/schema/posts.ts',
    ])
    expect(readFileSync(model.model, 'utf8')).toContain(`from '~/modules/blog/database/schema/posts'`)
    expect(model.hint).toContain('db:generate --module blog')

    await expect(make({
      root,
      srcDir,
      kind: 'controller',
      name: 'X',
      module: 'shop',
    })).rejects.toThrow('haze make:module shop')
    await expect(make({
      root,
      srcDir,
      kind: 'controller',
      name: 'X',
      module: 'blog',
      app: 'admin',
    })).rejects.toThrow(/--module/)
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

  it('generates notifications, broadcast channels and the notifications table', async () => {
    const notification = await make({
      root,
      srcDir,
      kind: 'notification',
      name: 'InvoicePaid',
    })
    expect(rel(notification.file)).toBe('server/app/notification/InvoicePaidNotification.ts')
    expect(readFileSync(notification.file, 'utf8')).toContain('defineNotification<InvoicePaidNotificationPayload>')
    const channel = await make({
      root,
      srcDir,
      kind: 'channel',
      name: 'Order',
    })
    expect(readFileSync(channel.file, 'utf8')).toContain(`c.private('order.{id}'`)

    for (const dialect of ['sqlite', 'postgres', 'mysql'] as const) {
      const table = await makeNotificationsTable({ root, srcDir, dialect, force: true })
      expect(rel(table.schema)).toBe('server/database/schema/notifications.ts')
      const content = readFileSync(table.schema, 'utf8')
      expect(content).toContain(`export const notifications = ${{ sqlite: 'sqliteTable', postgres: 'pgTable', mysql: 'mysqlTable' }[dialect]}('notifications'`)
      expect(content).toContain(`notifiableId: `)
    }
    await expect(makeNotificationsTable({ root, srcDir })).rejects.toThrow(/already exists/)
  })

  it('generates the auth tables schema for each SQL dialect', async () => {
    for (const dialect of ['sqlite', 'postgres', 'mysql'] as const) {
      const result = await makeAuthTables({ root, srcDir, dialect, force: true })
      expect(rel(result.schema)).toBe('server/database/schema/auth.ts')
      const content = readFileSync(result.schema, 'utf8')
      const table = { sqlite: 'sqliteTable', postgres: 'pgTable', mysql: 'mysqlTable' }[dialect]
      // JS 属性名与 @hazejs/orm 的 database*Store() 一致
      for (const [name, sqlName] of [
        ['personalAccessTokens', 'personal_access_tokens'],
        ['passwordResetTokens', 'password_reset_tokens'],
        ['twoFactorSecrets', 'two_factor_secrets'],
        ['webauthnCredentials', 'webauthn_credentials'],
      ])
        expect(content).toContain(`export const ${name} = ${table}('${sqlName}'`)
      for (const field of [
        'tokenableType:',
        'tokenableId:',
        'abilities:',
        'lastUsedAt:',
        'expiresAt:',
        'recoveryCodes:',
        'lastUsedStep:',
        'publicKey:',
        'counter:',
        'transports:',
        'backedUp:',
      ])
        expect(content).toContain(field)
    }
    await expect(makeAuthTables({ root, srcDir })).rejects.toThrow(/already exists/)
  })

  it('generates the database queue tables for each SQL dialect', async () => {
    for (const dialect of ['sqlite', 'postgres', 'mysql'] as const) {
      const result = await makeQueueTables({ root, srcDir, dialect, force: true })
      expect(rel(result.schema)).toBe('server/database/schema/queue.ts')
      const content = readFileSync(result.schema, 'utf8')
      const table = { sqlite: 'sqliteTable', postgres: 'pgTable', mysql: 'mysqlTable' }[dialect]
      expect(content).toContain(`from 'drizzle-orm/${{ sqlite: 'sqlite', postgres: 'pg', mysql: 'mysql' }[dialect]}-core'`)
      expect(content).toContain(`export const jobs = ${table}('jobs'`)
      expect(content).toContain(`export const failedJobs = ${table}('failed_jobs'`)
      // 列名与 @hazejs/orm 的 databaseQueue() 使用的 SQL 一致
      for (const column of [
        'queue',
        'payload',
        'attempts',
        'reserved_at',
        'available_at',
        'created_at',
        'uuid',
        'connection',
        'exception',
        'failed_at',
      ])
        expect(content).toContain(`('${column}'`)
      expect(content).not.toContain('~/')
    }
    expect((await makeQueueTables({ root, srcDir, force: true })).hint).toContain('driver: \'database\'')
    await expect(makeQueueTables({ root, srcDir })).rejects.toThrow(/already exists/)
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
