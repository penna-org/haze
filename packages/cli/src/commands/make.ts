import type { CommandDef } from 'citty'
import type { KindName } from '../make/generator'
import { existsSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import process from 'node:process'
import { loadThinkConfig } from '@think-h3/vite'
import { defineCommand } from 'citty'
import { consola } from 'consola'
import { colors } from 'consola/utils'
import { resolveRoot, rootArg } from '../args'
import { KINDS, make, makeModel } from '../make/generator'

function makeCommand(kind: KindName): CommandDef<any> {
  return defineCommand({
    meta: { name: `make:${kind}`, description: `生成${KINDS[kind].description}` },
    args: {
      name: { type: 'positional', description: '名称，可带子目录，例如 admin/User', required: true },
      ...rootArg,
      force: { type: 'boolean', description: '文件已存在时覆盖', default: false },
      app: { type: 'string', alias: 'a', description: '多应用：生成到 app/<app>/ 下' },
      ...(kind === 'controller' && {
        resource: {
          type: 'boolean',
          alias: 'r',
          description: '生成 RESTful 资源控制器',
          default: false,
        },
      }),
    },
    async run({ args }) {
      const root = resolveRoot(args.root)
      const { srcDir } = await loadThinkConfig(root)
      const result = await make({
        root,
        srcDir,
        kind,
        name: args.name,
        force: args.force,
        variant: variantOf(kind, root, args),
        app: args.app,
      })
      consola.success(`Created ${colors.cyan(relative(process.cwd(), result.file))}${result.custom
        ? colors.dim(` (stubs/${result.stub}.stub)`)
        : ''}`)
      if (result.hint)
        consola.info(result.hint)
    },
  })
}

function variantOf(kind: KindName, root: string, args: Record<string, unknown>): string | undefined {
  if (kind === 'controller' && args.resource)
    return 'controller.resource'
  // 项目只装了 zod 时使用 zod 版本
  if (kind === 'validate' && usesOnly(root, 'zod', 'valibot'))
    return 'validate.zod'
  return undefined
}

function usesOnly(root: string, wanted: string, other: string): boolean {
  const file = join(root, 'package.json')
  if (!existsSync(file))
    return false
  const pkg = JSON.parse(readFileSync(file, 'utf8')) as Record<string, Record<string, string> | undefined>
  const deps = {
    ...pkg.dependencies,
    ...pkg.devDependencies,
  }
  return wanted in deps && !(other in deps)
}

export const makeCommands = Object.fromEntries(
  (Object.keys(KINDS) as KindName[]).map(kind => [
    `make:${kind}`,
    makeCommand(kind),
  ]),
)

export const makeModelCommand = defineCommand({
  meta: { name: 'make:model', description: '生成模型与 drizzle 表结构（database/schema）' },
  args: {
    name: { type: 'positional', description: '模型名，例如 User 或 OrderItem', required: true },
    ...rootArg,
    table: { type: 'string', description: '表名（默认为复数下划线形式，例如 order_items）' },
    dialect: { type: 'string', description: 'sqlite | postgres | mysql（默认按已安装的驱动推断）' },
    softDelete: { type: 'boolean', description: '启用软删除', default: false },
    app: { type: 'string', alias: 'a', description: '多应用：模型生成到 app/<app>/model' },
    force: { type: 'boolean', description: '文件已存在时覆盖', default: false },
  },
  async run({ args }) {
    const root = resolveRoot(args.root)
    const { srcDir } = await loadThinkConfig(root)
    const dialect = (args.dialect ?? detectDialect(root)) as 'sqlite' | 'postgres' | 'mysql'
    if (!['sqlite', 'postgres', 'mysql'].includes(dialect))
      throw new Error(`Unknown dialect "${dialect}"`)
    const result = await makeModel({
      root,
      srcDir,
      name: args.name,
      table: args.table,
      dialect,
      softDelete: args.softDelete,
      app: args.app,
      force: args.force,
    })
    consola.success(`Created ${colors.cyan(relative(process.cwd(), result.model))}`)
    if (result.schema)
      consola.success(`Created ${colors.cyan(relative(process.cwd(), result.schema))} ${colors.dim(`(${dialect})`)}`)
    consola.info(result.hint)
  },
})

function detectDialect(root: string): string {
  if (usesOnly(root, 'mysql2', '@libsql/client'))
    return 'mysql'
  if (usesOnly(root, 'postgres', '@libsql/client') || usesOnly(root, '@electric-sql/pglite', '@libsql/client'))
    return 'postgres'
  return 'sqlite'
}
