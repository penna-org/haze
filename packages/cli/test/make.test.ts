import type { KindName } from '../src/make/generator'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { KINDS, make } from '../src/make/generator'
import { camelCase, kebabCase, parseName, plural } from '../src/make/naming'

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
      validate: 'server/app/validate/admin/user-profile.ts',
      test: 'tests/admin/user-profile.test.ts',
      config: 'server/config/userProfile.ts',
      route: 'server/route/user-profile.ts',
    }
    for (const kind of Object.keys(KINDS) as KindName[]) {
      // config / route 只按第一层自动发现，不带子目录
      const name = kind === 'config' || kind === 'route' || kind === 'interceptor'
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
