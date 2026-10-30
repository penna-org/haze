import type { AutoImportContext } from '../src'
import type { Fixture } from './utils'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { copyFixture, scanned } from './utils'

describe('stripImports', () => {
  let fixture: Fixture
  let context: AutoImportContext

  beforeEach(async () => {
    fixture = copyFixture()
    context = await scanned(fixture)
  })

  afterEach(() => fixture.cleanup())

  const strip = (code: string, file = 'app/controller/Test.ts'): string => context.stripImports(code, fixture.file(file))

  it('removes imports that would be auto-imported', () => {
    expect(strip([
      `import type { UserDto } from '~/app/service/UserService'`,
      `import { UserService } from '~/app/service/UserService.js'`,
      `import UserRegistered from '../event/UserRegistered'`,
      `import * as path from 'node:path'`,
      `import { basename, type ParsedPath } from 'node:path'`,
      ``,
      `export const run = (dto: UserDto): ParsedPath => path.parse(basename(new UserService().list()[dto.id]))`,
      `export const event = UserRegistered`,
      ``,
    ].join('\n'))).toBe([
      `export const run = (dto: UserDto): ParsedPath => path.parse(basename(new UserService().list()[dto.id]))`,
      `export const event = UserRegistered`,
      ``,
    ].join('\n'))
  })

  it('keeps imports that differ from the auto import', () => {
    const code = [
      `import 'reflect-metadata'`,
      `import { UserService as Users } from '~/app/service/UserService'`,
      `import { OrderService } from 'some-package'`,
      `import { notExported } from '~/app/service/UserService'`,
      `import { join } from 'node:path'`,
      ``,
      `export default [Users, OrderService, notExported, join]`,
      ``,
    ].join('\n')
    expect(strip(code)).toBe(code)
  })

  it('rewrites partially auto-imported declarations', () => {
    expect(strip([
      `// header`,
      `import type { UserDto, Unknown } from '~/app/service/UserService'`,
      `import Named, { helper } from '~/app/model/Named'`,
      `import { type ParsedPath, join, basename } from 'node:path';`,
      `export {}`,
    ].join('\n'))).toBe([
      `// header`,
      `import type { Unknown } from '~/app/service/UserService'`,
      `import { helper } from '~/app/model/Named'`,
      `import { join } from 'node:path'`,
      `export {}`,
    ].join('\n'))
  })
})
