import type { AutoImportContext, AutoImportOptions } from '../src'
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { normalizePath } from 'vite'
import { createAutoImport } from '../src'

const testDir = dirname(fileURLToPath(import.meta.url))
let counter = 0

/** 测试用的依赖包导入：命名空间、具名与只有类型 */
export const NODE_PATH_IMPORTS: AutoImportOptions['imports'] = [
  {
    from: 'node:path',
    imports: [
      ['*', 'path'],
      'basename',
      { name: 'ParsedPath', type: true },
    ],
  },
]

export interface Fixture {
  root: string
  file: (path: string) => string
  write: (path: string, content: string) => void
  remove: (path: string) => void
  cleanup: () => void
}

/** 复制 fixture 到 test/.tmp 下 */
export function copyFixture(name = 'project'): Fixture {
  const root = normalizePath(join(testDir, '.tmp', `${name}-${process.pid}-${++counter}`))
  rmSync(root, { recursive: true, force: true })
  mkdirSync(dirname(root), { recursive: true })
  cpSync(join(testDir, 'fixtures', name), root, { recursive: true })
  return {
    root,
    file: path => `${root}/${path}`,
    write(path, content) {
      mkdirSync(dirname(join(root, path)), { recursive: true })
      writeFileSync(join(root, path), content)
    },
    remove: path => rmSync(join(root, path)),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  }
}

export async function scanned(fixture: Fixture, options: Partial<AutoImportOptions> = {}): Promise<AutoImportContext> {
  const context = createAutoImport({ srcDir: fixture.root, imports: NODE_PATH_IMPORTS, ...options })
  await context.scan()
  return context
}
