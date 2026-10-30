import type { AutoImportEntry, ImportSource } from '../src'
import type { Fixture } from './utils'
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import corePreset from '../../core/src/auto-imports'
import ormPreset from '../../orm/src/auto-imports'
import { createAutoImport, generateDts, scanFileExports } from '../src'
import { copyFixture } from './utils'

const packagesDir = fileURLToPath(new URL('../../', import.meta.url))
const TYPE_ROOTS = fileURLToPath(new URL('../../../node_modules/@types', import.meta.url))

const PRESETS: Array<[name: string, preset: ImportSource]> = [
  ['core', corePreset],
  ['orm', ormPreset],
]

function entriesOf(preset: ImportSource): AutoImportEntry[] {
  return preset.imports.map(item => typeof item === 'string'
    ? { name: item, as: item, from: preset.from }
    : Array.isArray(item)
      ? { name: item[0], as: item[1], from: preset.from }
      : {
          name: item.name,
          as: item.as ?? item.name,
          from: preset.from,
          ...(item.type && { type: true }),
        })
}

describe('framework presets', () => {
  it.each(PRESETS)('%s: every name is exported, with the right kind', (name, preset) => {
    const exported = new Map(scanFileExports(`${packagesDir}${name}/src/index.ts`).exports.map(item => [item.name, item.type]))
    const problems = entriesOf(preset).flatMap((entry) => {
      if (!exported.has(entry.name))
        return [`${entry.name} is not exported`]
      if (exported.get(entry.name) !== Boolean(entry.type)) {
        return [`${entry.name} should be ${exported.get(entry.name)
          ? '{ type: true }'
          : 'a value'}`]
      }
      return []
    })
    expect(problems).toEqual([])
  })

  it('has no duplicate names and does not shadow runtime globals', () => {
    const names = PRESETS.flatMap(([, preset]) => entriesOf(preset).map(entry => entry.as))
    expect(names.filter((name, index) => names.indexOf(name) !== index)).toEqual([])
    expect(names.filter(name => name in globalThis)).toEqual([])
  })

  it('generates global declarations that do not conflict with @types/node', () => {
    const fixture = copyFixture()
    try {
      const dts = fixture.file('.haze/types/auto-imports.d.ts')
      mkdirSync(fixture.file('.haze/types'), { recursive: true })
      writeFileSync(dts, generateDts(PRESETS.flatMap(([, preset]) => entriesOf(preset)), dts))
      const usage = fixture.file('usage.ts')
      writeFileSync(usage, [
        `export default defineRoutes((r) => {`,
        `  r.get('/', (ctx: HttpContext) => ({ q: ctx.query('q'), name: env('APP_NAME', 'x') }))`,
        `})`,
        `export class Users { private config = inject(Config) }`,
        `export const fail = () => { throw new NotFoundException('missing') }`,
        `export type Q = ModelQuery<any>`,
        `// @ts-expect-error 类型只在类型位置可用`,
        `export const notValue = Next`,
        `export const handle = (ctx: HttpContext, next: Next): ReturnType<Next> => next()`,
      ].join('\n'))

      const program = ts.createProgram([dts, usage], {
        target: ts.ScriptTarget.ES2023,
        lib: ['lib.es2023.d.ts'],
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        moduleDetection: ts.ModuleDetectionKind.Force,
        strict: true,
        noEmit: true,
        isolatedModules: true,
        verbatimModuleSyntax: true,
        skipLibCheck: false,
        types: ['node'],
        typeRoots: [TYPE_ROOTS],
        paths: {
          '@hazejs/core': [`${packagesDir}core/src/index.ts`],
          '@hazejs/orm': [`${packagesDir}orm/src/index.ts`],
        },
      })
      const diagnostics = [dts, usage].flatMap((file) => {
        const source = program.getSourceFile(file)!
        return [
          ...program.getSyntacticDiagnostics(source),
          ...program.getSemanticDiagnostics(source),
        ]
      })
      expect(diagnostics.map(item => ts.flattenDiagnosticMessageText(item.messageText, '\n'))).toEqual([])
    }
    finally {
      fixture.cleanup()
    }
  })
})

describe('preset loading', () => {
  let fixture: Fixture

  beforeEach(() => {
    fixture = copyFixture()
    fixture.write('package.json', JSON.stringify({
      type: 'module',
      dependencies: { '@hazejs/fake': '1.0.0', 'other-lib': '1.0.0' },
    }))
    fixture.write('node_modules/@hazejs/fake/package.json', JSON.stringify({
      name: '@hazejs/fake',
      type: 'module',
      exports: { './auto-imports': './auto-imports.js' },
    }))
    fixture.write('node_modules/@hazejs/fake/auto-imports.js', `export default { from: '@hazejs/fake', imports: ['defineFake', 'UserService', { name: 'FakeType', type: true }] }`)
    // 不在 @hazejs 范围内的包不会被自动发现
    fixture.write('node_modules/other-lib/package.json', JSON.stringify({
      name: 'other-lib',
      type: 'module',
      exports: { './auto-imports': './auto-imports.js' },
    }))
    fixture.write('node_modules/other-lib/auto-imports.js', `export default { from: 'other-lib', imports: ['otherThing'] }`)
  })

  afterEach(() => fixture.cleanup())

  it('detects presets of installed @hazejs packages', async () => {
    const context = createAutoImport({ srcDir: fixture.root })
    await context.scan()
    const entries = Object.fromEntries(context.entries().map(entry => [entry.as, entry]))
    expect(entries.defineFake).toEqual({ name: 'defineFake', as: 'defineFake', from: '@hazejs/fake' })
    expect(entries.FakeType).toEqual({
      name: 'FakeType',
      as: 'FakeType',
      from: '@hazejs/fake',
      type: true,
    })
    expect(entries.otherThing).toBeUndefined()
    // 项目中的导出优先于预设
    expect(entries.UserService.from).toBe(fixture.file('app/service/UserService.ts'))
    expect(context.conflicts().find(item => item.name === 'UserService')!.ignored).toEqual([
      { name: 'UserService', as: 'UserService', from: '@hazejs/fake' },
    ])
  })

  it('uses explicit presets, or none', async () => {
    const explicit = createAutoImport({
      srcDir: fixture.root,
      presets: ['other-lib'],
    })
    await explicit.scan()
    const names = explicit.entries().map(entry => entry.as)
    expect(names).toContain('otherThing')
    expect(names).not.toContain('defineFake')

    const none = createAutoImport({ srcDir: fixture.root, presets: [] })
    await none.scan()
    expect(none.entries().map(entry => entry.as)).not.toContain('defineFake')
  })

  it('resolves presets from the project root when srcDir is a subdirectory', async () => {
    const context = createAutoImport({
      srcDir: fixture.file('app'),
      root: fixture.root,
      dirs: [],
    })
    await context.scan()
    expect(context.entries().map(entry => entry.as)).toContain('defineFake')
  })

  it('fails clearly when a preset cannot be found', async () => {
    const context = createAutoImport({
      srcDir: fixture.root,
      presets: ['missing-lib'],
    })
    await expect(context.scan()).rejects.toThrow('Cannot find the auto-import preset of "missing-lib"')
  })
})
