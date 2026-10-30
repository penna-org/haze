import type { Plugin } from 'vite'
import type { AutoImportContext } from '../src'
import type { Fixture } from './utils'
import { createServer } from 'vite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { copyFixture, scanned } from './utils'

describe('transform', () => {
  let fixture: Fixture
  let context: AutoImportContext

  beforeEach(async () => {
    fixture = copyFixture()
    context = await scanned(fixture)
  })

  afterEach(() => fixture.cleanup())

  const transform = async (code: string, id = fixture.file('app/controller/Test.ts')): Promise<string | undefined> =>
    (await context.transform(code, id))?.code

  it('injects imports for used names', async () => {
    const code = await transform('export const run = () => [new UserService(), UserRegistered.emit({ name: "x" }), path.sep]')
    expect(code).toContain(`import { UserService } from '${fixture.file('app/service/UserService.ts')}';`)
    expect(code).toContain(`import UserRegistered from '${fixture.file('app/event/UserRegistered.ts')}';`)
    expect(code).toContain(`import * as path from 'node:path';`)
  })

  it('returns a source map', async () => {
    const result = await context.transform('new UserService()', fixture.file('app/controller/Test.ts'))
    expect(result!.map).toMatchObject({
      sources: [
        expect.stringContaining('Test.ts'),
      ],
    })
  })

  it('skips declared, imported, type-only and unused names', async () => {
    expect(await transform('const UserService = 1\nexport default UserService')).toBeUndefined()
    expect(await transform('import { UserService } from "./elsewhere"\nnew UserService()')).toBeUndefined()
    // 只有类型的导出没有运行时的值（正常情况下类型已在 TS 转换中去掉，这里模拟同名的标识符）
    expect(await transform('console.log(UserDto, ParsedPath)')).toBeUndefined()
    expect(await transform('const text = "UserService"; // UserService')).toBeUndefined()
    expect(await transform('foo.UserService()')).toBeUndefined()
  })

  it('does not import a file into itself', async () => {
    expect(await transform('export class Box {}\nexport const make = () => new UserService()', fixture.file('app/service/UserService.ts'))).toBeUndefined()
  })

  it('skips dependencies, declaration files and virtual modules', async () => {
    expect(await transform('new UserService()', `${fixture.root}/node_modules/pkg/index.js`)).toBeUndefined()
    expect(await transform('new UserService()', fixture.file('types.d.ts'))).toBeUndefined()
    expect(await transform('new UserService()', '\0virtual:test')).toBeUndefined()
    expect(await transform('new UserService()', fixture.file('style.css'))).toBeUndefined()
    // 查询参数不影响判断
    expect(await transform('new UserService()', `${fixture.file('app/controller/Test.ts')}?v=1`)).toContain('UserService')
  })

  it('runs in Vite after TypeScript is stripped', async () => {
    const plugin: Plugin = {
      name: 'test:auto-import',
      transform: (code, id) => context.transform(code, id),
    }
    const server = await createServer({
      root: fixture.root,
      configFile: false,
      logLevel: 'silent',
      server: { middlewareMode: true, ws: false, watch: null },
      optimizeDeps: { noDiscovery: true, entries: [] },
      plugins: [plugin],
    })
    try {
      const { UserController } = await server.ssrLoadModule(fixture.file('app/controller/UserController.ts'))
      const controller = new UserController()
      expect(controller.index()).toEqual([
        { id: 0 },
        { id: 1 },
      ])
      expect(controller.run()).toEqual([
        'registered ada',
        'receipt #7',
        42,
        'ADA',
        10001,
        'named',
        1,
        'admin',
        'b',
      ])
    }
    finally {
      await server.close()
    }
  })
})
