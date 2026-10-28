import type { CommandDef } from 'citty'
import type { KindName } from '../make/generator'
import { existsSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import process from 'node:process'
import { loadHazeConfig } from '@hazejs/vite'
import { defineCommand } from 'citty'
import { consola } from 'consola'
import { colors } from 'consola/utils'
import { resolveRoot, rootArg } from '../args'
import { KINDS, make, makeAuthTables, makeModel, makeModule, makeNotificationsTable } from '../make/generator'

function makeCommand(kind: KindName): CommandDef<any> {
  return defineCommand({
    meta: { name: `make:${kind}`, description: `生成${KINDS[kind].description}` },
    args: {
      name: { type: 'positional', description: '名称，可带子目录，例如 admin/User', required: true },
      ...rootArg,
      force: { type: 'boolean', description: '文件已存在时覆盖', default: false },
      app: { type: 'string', alias: 'a', description: '多应用：生成到 app/<app>/ 下' },
      module: { type: 'string', alias: 'm', description: '本地模块：生成到 modules/<module>/ 下' },
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
      const { srcDir } = await loadHazeConfig(root)
      const result = await make({
        root,
        srcDir,
        kind,
        name: args.name,
        force: args.force,
        variant: variantOf(kind, root, args),
        app: args.app,
        module: args.module,
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
    dialect: { type: 'string', description: 'sqlite | postgres | mysql | mongodb（默认按已安装的驱动推断）' },
    softDelete: { type: 'boolean', description: '启用软删除', default: false },
    app: { type: 'string', alias: 'a', description: '多应用：模型生成到 app/<app>/model' },
    module: { type: 'string', alias: 'm', description: '本地模块：模型与表结构生成到 modules/<module>/ 下' },
    force: { type: 'boolean', description: '文件已存在时覆盖', default: false },
  },
  async run({ args }) {
    const root = resolveRoot(args.root)
    const { srcDir } = await loadHazeConfig(root)
    const dialect = (args.dialect ?? detectDialect(root)) as 'sqlite' | 'postgres' | 'mysql' | 'mongodb'
    if (![
      'sqlite',
      'postgres',
      'mysql',
      'mongodb',
    ].includes(dialect)) {
      throw new Error(`Unknown dialect "${dialect}"`)
    }
    const result = await makeModel({
      root,
      srcDir,
      name: args.name,
      table: args.table,
      dialect,
      softDelete: args.softDelete,
      app: args.app,
      module: args.module,
      force: args.force,
    })
    consola.success(`Created ${colors.cyan(relative(process.cwd(), result.model))}`)
    if (result.schema)
      consola.success(`Created ${colors.cyan(relative(process.cwd(), result.schema))} ${colors.dim(`(${dialect})`)}`)
    consola.info(result.hint)
  },
})

function detectDialect(root: string): string {
  if (usesOnly(root, 'mongodb', '@libsql/client') && usesOnly(root, 'mongodb', 'mysql2') && usesOnly(root, 'mongodb', 'postgres'))
    return 'mongodb'
  if (usesOnly(root, 'mysql2', '@libsql/client'))
    return 'mysql'
  if (usesOnly(root, 'postgres', '@libsql/client') || usesOnly(root, '@electric-sql/pglite', '@libsql/client'))
    return 'postgres'
  return 'sqlite'
}

export const makeNotificationsTableCommand = defineCommand({
  meta: { name: 'make:notifications-table', description: '生成通知表结构（database/schema/notifications.ts）' },
  args: {
    ...rootArg,
    dialect: { type: 'string', description: 'sqlite | postgres | mysql（默认按已安装的驱动推断）' },
    force: { type: 'boolean', description: '文件已存在时覆盖', default: false },
  },
  async run({ args }) {
    const root = resolveRoot(args.root)
    const { srcDir } = await loadHazeConfig(root)
    const dialect = args.dialect ?? detectDialect(root)
    if (![
      'sqlite',
      'postgres',
      'mysql',
    ].includes(dialect)) {
      throw new Error(`The notifications table needs a SQL database (got "${dialect}")`)
    }
    const result = await makeNotificationsTable({
      root,
      srcDir,
      dialect: dialect as 'sqlite' | 'postgres' | 'mysql',
      force: args.force,
    })
    consola.success(`Created ${colors.cyan(relative(process.cwd(), result.schema))} ${colors.dim(`(${dialect})`)}`)
    consola.info(result.hint)
  },
})

export const makeAuthTablesCommand = defineCommand({
  meta: { name: 'make:auth-tables', description: '生成认证扩展的表结构（database/schema/auth.ts：API 令牌、找回密码、两步验证、通行密钥）' },
  args: {
    ...rootArg,
    dialect: { type: 'string', description: 'sqlite | postgres | mysql（默认按已安装的驱动推断）' },
    force: { type: 'boolean', description: '文件已存在时覆盖', default: false },
  },
  async run({ args }) {
    const root = resolveRoot(args.root)
    const { srcDir } = await loadHazeConfig(root)
    const dialect = args.dialect ?? detectDialect(root)
    if (![
      'sqlite',
      'postgres',
      'mysql',
    ].includes(dialect)) {
      throw new Error(`The auth tables need a SQL database (got "${dialect}")`)
    }
    const result = await makeAuthTables({
      root,
      srcDir,
      dialect: dialect as 'sqlite' | 'postgres' | 'mysql',
      force: args.force,
    })
    consola.success(`Created ${colors.cyan(relative(process.cwd(), result.schema))} ${colors.dim(`(${dialect})`)}`)
    consola.info(result.hint)
  },
})

export const makeModuleCommand = defineCommand({
  meta: { name: 'make:module', description: '生成本地模块骨架（modules/<name>/：module.ts、路由、控制器、配置、测试）' },
  args: {
    name: { type: 'positional', description: '模块名，例如 blog', required: true },
    ...rootArg,
    force: { type: 'boolean', description: '目录已存在时覆盖', default: false },
  },
  async run({ args }) {
    const root = resolveRoot(args.root)
    const { srcDir } = await loadHazeConfig(root)
    const result = await makeModule({
      root,
      srcDir,
      name: args.name,
      force: args.force,
    })
    for (const file of result.files)
      consola.success(`Created ${colors.cyan(relative(process.cwd(), file))}`)
    consola.info(result.hint)
  },
})
