import type { Fixture } from './utils'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { copyFixture, scanned } from './utils'

/** 仓库根目录的 @types（@types/node） */
const TYPE_ROOTS = fileURLToPath(new URL('../../../node_modules/@types', import.meta.url))

/** 与 create-hazejs 模板一致的严格配置 */
const BASE_OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2023,
  lib: ['lib.es2023.d.ts'],
  moduleDetection: ts.ModuleDetectionKind.Force,
  strict: true,
  noEmit: true,
  isolatedModules: true,
  verbatimModuleSyntax: true,
  skipLibCheck: false,
  types: ['node'],
}

/** 类型检查：fixture 中的 `@ts-expect-error` 也会被检查（类型退化为 any 时报“未使用的指令”） */
function typecheck(fixture: Fixture, dts: string, options: ts.CompilerOptions): string[] {
  const files = ts.sys.readDirectory(fixture.root, ['.ts'], ['node_modules'], ['**/*'])
  const program = ts.createProgram([...files, dts], {
    ...BASE_OPTIONS,
    ...options,
    typeRoots: [TYPE_ROOTS],
  })
  return ts.getPreEmitDiagnostics(program).map((diagnostic) => {
    const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')
    if (!diagnostic.file)
      return message
    const { line } = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start!)
    return `${diagnostic.file.fileName.slice(fixture.root.length + 1)}:${line + 1} ${message}`
  })
}

describe('type declarations', () => {
  let fixture: Fixture

  beforeEach(() => {
    fixture = copyFixture()
  })

  afterEach(() => fixture.cleanup())

  it('generates aliases through a self re-export', async () => {
    const context = await scanned(fixture)
    const file = fixture.file('.haze/types/auto-imports.d.ts')
    expect(await context.writeDts(file)).toBe(true)
    expect(await context.writeDts(file)).toBe(false)

    const content = readFileSync(file, 'utf8')
    expect(content).toContain(`import * as __autoImports from "./auto-imports.js"`)
    expect(content).toContain(`export { Box, ErrorCode, Role, UserService } from "../../app/service/UserService.ts"`)
    // 只有类型的导出在 declare global 中以 export type 再导出
    expect(content).toContain(`  // @ts-ignore\n  export type { declared, UserDto, UserId } from "../../app/service/UserService.ts"`)
    expect(content).toContain(`export { default as UserRegistered } from "../../app/event/UserRegistered.ts"`)
    expect(content).toContain(`import * as __autoImports_path from "node:path"`)
    expect(content).toContain(`  export import path = __autoImports_path`)
    expect(content).toContain(`export { basename } from "node:path"`)
    expect(content).toContain(`  export type { ParsedPath } from "node:path"`)
    expect(content).toContain(`  export import UserService = __autoImports.UserService`)
    expect(content).toContain(`  export import sendReceipt = __autoImports.sendReceipt`)
  })

  it.each([
    [
      'bundler',
      { module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler },
    ],
    [
      'nodenext',
      { module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext },
    ],
  ])('keeps values, class types, generics and default exports typed (%s)', async (_, options) => {
    const context = await scanned(fixture)
    const file = fixture.file('.haze/types/auto-imports.d.ts')
    await context.writeDts(file)
    expect(typecheck(fixture, file, options)).toEqual([])
  })

  it('reports usages that are not declared', async () => {
    const context = await scanned(fixture, {
      ignore: ['OrderService'],
    })
    const file = fixture.file('.haze/types/auto-imports.d.ts')
    await context.writeDts(file)
    expect(typecheck(fixture, file, BASE_OPTIONS)).toEqual([
      `app/controller/UserController.ts:15 Cannot find name 'OrderService'.`,
    ])
  })
})
