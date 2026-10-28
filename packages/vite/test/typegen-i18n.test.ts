import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { writeTypes } from '../src/typegen'
import { generateI18nTypes, i18nTypesFile, writeI18nTypes } from '../src/typegen-i18n'
import { copyFixture } from './utils'

let fixture: ReturnType<typeof copyFixture> | undefined
afterEach(() => {
  fixture?.cleanup()
  fixture = undefined
})

describe('i18n typegen', () => {
  it('emits GeneratedTranslations from the reference locale, including nested directories and JSON', async () => {
    fixture = copyFixture('basic')
    fixture.write('lang/en/messages.ts', `export default { welcome: 'Welcome, {name}', apples: { one: 'One apple', other: '{count} apples' } }\n`)
    fixture.write('lang/en/admin/users.ts', `export default { title: 'Users' }\n`)
    fixture.write('lang/en/errors.json', `{ "gone": "Gone" }\n`)
    fixture.write('lang/zh-CN/messages.ts', `export default { welcome: '欢迎，{name}' }\n`)

    const result = generateI18nTypes({ root: fixture.root, srcDir: fixture.root })
    expect(result.locale).toBe('en')
    expect(result.files).toEqual(['admin/users', 'errors', 'messages'])
    expect(result.file).toBe(join(fixture.root, '.haze/types/i18n.d.ts'))
    expect(result.content).toContain('interface GeneratedTranslations {')
    expect(result.content).toContain('"messages": typeof import("../../lang/en/messages").default')
    expect(result.content).toContain('"admin": {\n      "users": typeof import("../../lang/en/admin/users").default\n    }')
    expect(result.content).toContain('"errors": typeof import("../../lang/en/errors.json")')

    // 指定语言；不存在时回退到 en
    expect(generateI18nTypes({ root: fixture.root, srcDir: fixture.root, locale: 'zh-CN' }).files).toEqual(['messages'])
    expect(generateI18nTypes({ root: fixture.root, srcDir: fixture.root, locale: 'fr' }).locale).toBe('en')

    // 只在内容变化时写入
    expect((await writeI18nTypes({ root: fixture.root, srcDir: fixture.root })).changed).toBe(true)
    expect((await writeI18nTypes({ root: fixture.root, srcDir: fixture.root })).changed).toBe(false)
  })

  it('writes an empty interface without lang/ and runs as part of writeTypes()', async () => {
    fixture = copyFixture('basic')
    const empty = generateI18nTypes({ root: fixture.root, srcDir: fixture.root })
    expect(empty.locale).toBeUndefined()
    expect(empty.content).toContain('interface GeneratedTranslations {\n\n  }')

    fixture.write('server/lang/zh-CN/messages.ts', `export default { hi: '你好' }\n`)
    await writeTypes({
      root: fixture.root,
      srcDir: join(fixture.root, 'server'),
      routes: [],
    })
    const file = i18nTypesFile(fixture.root)
    expect(existsSync(file)).toBe(true)
    expect(readFileSync(file, 'utf8')).toContain('"messages": typeof import("../../server/lang/zh-CN/messages").default')
  })
})
