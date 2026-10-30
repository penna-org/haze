import type { Fixture } from './utils'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { defaultExportName } from '../src'
import { copyFixture, scanned } from './utils'

describe('scan', () => {
  let fixture: Fixture

  beforeEach(() => {
    fixture = copyFixture()
  })

  afterEach(() => fixture.cleanup())

  it('collects named and default exports from the default dirs', async () => {
    const context = await scanned(fixture)
    const entries = Object.fromEntries(context.entries().map(entry => [entry.as, entry]))

    expect(entries.UserService).toEqual({
      name: 'UserService',
      as: 'UserService',
      from: fixture.file('app/service/UserService.ts'),
    })
    expect(entries.Role).toEqual({
      name: 'Role',
      as: 'Role',
      from: fixture.file('app/service/UserService.ts'),
    })
    expect(entries.ErrorCode.type).toBeUndefined()
    // 匿名默认导出取文件名，具名的默认导出取声明的名字
    expect(entries.UserRegistered).toEqual({
      name: 'default',
      as: 'UserRegistered',
      from: fixture.file('app/event/UserRegistered.ts'),
    })
    expect(entries.sendReceipt).toEqual({
      name: 'default',
      as: 'sendReceipt',
      from: fixture.file('app/job/send-receipt.ts'),
    })
    expect(entries.Named).toEqual({
      name: 'default',
      as: 'Named',
      from: fixture.file('app/model/Named.ts'),
    })
    // 本地模块
    expect(entries.OrderService.from).toBe(fixture.file('modules/shop/app/service/OrderService.ts'))
    // 控制器所在目录也会被扫描，database/schema 不在默认目录中
    expect(entries.UserController).toBeDefined()
    expect(entries.users).toBeUndefined()
  })

  it('marks type-only exports', async () => {
    const context = await scanned(fixture)
    const types = context.entries().filter(entry => entry.type).map(entry => entry.as)
    expect(types).toEqual([
      'declared',
      'Formatter',
      'ParsedPath',
      'UserDto',
      'UserId',
    ])
  })

  it('reports conflicts but not the same export re-exported through an index file', async () => {
    const context = await scanned(fixture)
    expect(context.conflicts()).toEqual([
      {
        name: 'formatName',
        used: {
          name: 'formatName',
          as: 'formatName',
          from: fixture.file('app/service/shared/helpers.ts'),
        },
        ignored: [
          {
            name: 'formatName',
            as: 'formatName',
            from: fixture.file('modules/shop/app/service/OrderService.ts'),
          },
        ],
      },
    ])
  })

  it('respects dirs order and ignore', async () => {
    const context = await scanned(fixture, {
      dirs: ['modules/*/app/service', 'app/service/**'],
      ignore: ['UserService'],
    })
    const names = context.entries().map(entry => entry.as)
    expect(names).not.toContain('UserService')
    expect(names).not.toContain('UserController')
    expect(context.entries().find(entry => entry.as === 'formatName')!.from).toBe(fixture.file('modules/shop/app/service/OrderService.ts'))
  })

  it('follows re-exports and local export lists', async () => {
    fixture.write('app/service/barrel.ts', [
      `import type { UserDto } from './UserService'`,
      `import { UserService as Users } from './UserService.js'`,
      `const local = 1`,
      `interface LocalType {}`,
      `export { Users, local, LocalType, UserDto as Dto }`,
      `export { Role as Roles, type ErrorCode as Codes } from './UserService'`,
      `export * as shared from './shared'`,
      `export { join } from 'node:path'`,
    ].join('\n'))
    const context = await scanned(fixture, {
      dirs: ['app/service/barrel.ts'],
    })
    expect(context.entries().filter(entry => !entry.from.startsWith('node:')).map(({ as, type }) => ({ as, type }))).toEqual([
      { as: 'Codes', type: true },
      { as: 'Dto', type: true },
      { as: 'local', type: undefined },
      { as: 'LocalType', type: true },
      { as: 'Roles', type: undefined },
      { as: 'shared', type: undefined },
      { as: 'join', type: undefined },
      { as: 'Users', type: undefined },
    ].sort((a, b) => a.as.localeCompare(b.as)))
  })

  it('updates when files are created, changed and deleted', async () => {
    const context = await scanned(fixture)

    fixture.write('app/service/MailService.ts', 'export class MailService {}')
    expect(await context.update(fixture.file('app/service/MailService.ts'), 'create')).toBe(true)
    expect(context.entries().map(entry => entry.as)).toContain('MailService')

    // 导出没有变化
    fixture.write('app/service/MailService.ts', 'export class MailService { send() {} }')
    expect(await context.update(fixture.file('app/service/MailService.ts'), 'update')).toBe(false)

    fixture.write('app/service/MailService.ts', 'export class Mailer {}')
    expect(await context.update(fixture.file('app/service/MailService.ts'), 'update')).toBe(true)
    expect(context.entries().map(entry => entry.as)).toContain('Mailer')

    fixture.remove('app/service/MailService.ts')
    expect(await context.update(fixture.file('app/service/MailService.ts'), 'delete')).toBe(true)
    expect(context.entries().map(entry => entry.as)).not.toContain('Mailer')

    // 不在扫描目录中的文件
    expect(await context.update(fixture.file('database/schema/users.ts'), 'update')).toBe(false)
  })

  it('rescans dependents when a re-exported file changes', async () => {
    const context = await scanned(fixture, {
      dirs: ['app/service/shared/index.ts'],
    })
    expect(context.entries().map(entry => entry.as)).toContain('formatName')

    fixture.write('app/service/shared/helpers.ts', 'export function format(name: string) { return name }')
    expect(await context.update(fixture.file('app/service/shared/helpers.ts'), 'update')).toBe(true)
    expect(context.entries().map(entry => entry.as)).toContain('format')
  })
})

describe('defaultExportName', () => {
  it.each([
    ['/app/event/UserRegistered.ts', 'UserRegistered'],
    ['/app/job/send-receipt.ts', 'sendReceipt'],
    ['/app/job/send_receipt.ts', 'send_receipt'],
    ['/app/service/user/index.ts', 'user'],
    ['/app/model/2fa.ts', '_2fa'],
  ])('%s → %s', (file, name) => {
    expect(defaultExportName(file)).toBe(name)
  })
})
