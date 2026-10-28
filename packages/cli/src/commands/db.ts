import type { DevServer } from '@hazejs/vite'
import { spawn } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import process from 'node:process'
import { createDevServer, loadHazeConfig } from '@hazejs/vite'
import { defineCommand } from 'citty'
import { consola } from 'consola'
import { resolveRoot, rootArg } from '../args'
import { binOf } from '../resolve'

interface ConnectionConfig {
  driver: 'sqlite' | 'turso' | 'd1' | 'postgres' | 'pglite' | 'mysql' | 'mongodb'
  url?: string
  schema?: string
  migrations?: string
}

interface DatabaseConfig {
  default: string
  connections: Record<string, ConnectionConfig>
}

interface Target {
  name: string
  config: ConnectionConfig
  /** drizzle-kit 的 dialect */
  dialect: 'sqlite' | 'postgresql' | 'mysql'
  schema: string
  migrations: string
}

/** 启动（不监听端口的）开发服务器以读取配置；db:migrate / db:seed 也在应用的模块图中执行 */
async function withApp<T>(root: string, run: (server: DevServer, database: DatabaseConfig, srcDir: string) => Promise<T>): Promise<T> {
  const { srcDir } = await loadHazeConfig(root)
  const server = await createDevServer({ root, listen: false })
  try {
    if (!server.app)
      throw new Error('Application failed to start')
    const database = server.app.config.get<DatabaseConfig | undefined>('database', undefined)
    if (!database?.connections)
      throw new Error('config/database.ts is missing or invalid')
    return await run(server, database, srcDir)
  }
  finally {
    await server.close()
  }
}

function targetOf(database: DatabaseConfig, srcDir: string, name = database.default): Target {
  const config = database.connections[name]
  if (!config)
    throw new Error(`Database connection "${name}" is not defined in config/database.ts`)
  if (config.driver === 'mongodb')
    throw new MongoConnectionError(name)
  const dialect = config.driver === 'mysql'
    ? 'mysql'
    : ['sqlite', 'turso', 'd1'].includes(config.driver)
        ? 'sqlite'
        : 'postgresql'
  return {
    name,
    config,
    dialect,
    schema: resolve(srcDir, config.schema ?? 'database/schema'),
    migrations: resolve(srcDir, config.migrations ?? (name === database.default
      ? 'database/migrations'
      : `database/migrations/${name}`)),
  }
}

class MongoConnectionError extends Error {
  constructor(name: string) {
    super(`Connection "${name}" is MongoDB, which has no SQL schema or migrations`)
  }
}

const connectionArg = {
  connection: { type: 'string', alias: 'c', description: '连接名（默认 config/database.ts 中的 default）' },
} as const

export const generateCommand = defineCommand({
  meta: { name: 'db:generate', description: '根据 database/schema 的表结构变化生成迁移（drizzle-kit）' },
  args: {
    ...rootArg,
    ...connectionArg,
    module: { type: 'string', alias: 'm', description: '本地模块：读取 modules/<module>/database/schema，写入 modules/<module>/database/migrations' },
    name: { type: 'string', description: '迁移名称' },
    custom: { type: 'boolean', description: '生成空白迁移，手写 SQL', default: false },
  },
  async run({ args }) {
    const root = resolveRoot(args.root)
    const target = await withApp(root, async (server, database, srcDir) => {
      if (!args.module)
        return targetOf(database, srcDir, args.connection)
      // 模块的表结构与迁移在模块目录内，连接取 --connection、模块声明的连接或 default
      const module = server.app!.modules().find(item => item.name === args.module)
      if (!module || module.source !== 'local')
        throw new Error(`Local module "${args.module}" is not enabled (modules/${args.module}/)`)
      const target = targetOf(database, srcDir, args.connection ?? module.connection)
      return {
        ...target,
        schema: resolve(srcDir, 'modules', module.name, 'database/schema'),
        migrations: resolve(srcDir, module.migrations ?? `modules/${module.name}/database/migrations`),
      }
    })
    const kit = binOf(root, 'drizzle-kit')
    const kitArgs = [
      'generate',
      `--dialect=${target.dialect}`,
      `--schema=${relative(root, target.schema)}/*.ts`,
      `--out=${relative(root, target.migrations)}`,
      ...(args.name
        ? [`--name=${args.name}`]
        : []),
      ...(args.custom
        ? ['--custom']
        : []),
    ]
    const code = await new Promise<number>((done) => {
      spawn(process.execPath, [kit, ...kitArgs], { cwd: root, stdio: 'inherit' }).on('close', code => done(code ?? 1))
    })
    process.exitCode = code
  },
})

export const migrateCommand = defineCommand({
  meta: { name: 'db:migrate', description: '执行尚未运行的迁移' },
  args: {
    ...rootArg,
    ...connectionArg,
    all: { type: 'boolean', description: '对所有连接执行', default: false },
  },
  async run({ args }) {
    const root = resolveRoot(args.root)
    await withApp(root, async (server, _database, srcDir) => {
      // 与生产迁移入口（migrate.mjs / Lambda index.migrate）相同的实现，只是从源码目录读取迁移
      const orm = await server.import<typeof import('@hazejs/orm')>('@hazejs/orm')
      const results = await orm.runMigrations({ srcDir, connection: args.connection, all: args.all })
      // 每个连接先执行模块的迁移（按启用顺序，各自的记录表），最后是项目自身的迁移
      for (const result of results) {
        const label = result.module
          ? `[${result.connection}] module ${result.module}:`
          : `[${result.connection}]`
        if (result.skipped === 'mongodb')
          consola.info(`${label} MongoDB has no migrations, skipped`)
        else if (result.skipped && result.module)
          consola.info(`${label} no migrations in ${result.folder}`)
        else if (result.skipped)
          consola.warn(`${label} no migrations in ${result.folder}, run haze db:generate first`)
        else
          consola.success(`${label} migrated: ${result.applied} of ${result.total} applied (${result.folder})`)
      }
    })
  },
})

export const seedCommand = defineCommand({
  meta: { name: 'db:seed', description: '按文件名顺序执行 database/seeders 下的数据填充（已启用本地模块的 seeders 在前）' },
  args: {
    ...rootArg,
    file: { type: 'string', description: '只执行指定文件（不含扩展名）' },
  },
  async run({ args }) {
    const root = resolveRoot(args.root)
    await withApp(root, async (server, _database, srcDir) => {
      const dirs = [
        ...server.app!.modules().filter(module => module.source === 'local').map(module => join(srcDir, 'modules', module.name, 'database', 'seeders')),
        join(srcDir, 'database', 'seeders'),
      ]
      const files = dirs.flatMap(dir => existsSync(dir)
        ? readdirSync(dir).filter(file => /\.[cm]?[jt]s$/.test(file) && (!args.file || file.replace(/\.[^.]+$/, '') === args.file)).sort().map(file => join(dir, file))
        : [])
      if (!files.length) {
        consola.warn(`No seeders found in ${relative(root, dirs.at(-1)!)}`)
        return
      }
      for (const file of files) {
        const module = await server.import<{ default?: (app: unknown) => unknown }>(file)
        if (typeof module.default !== 'function')
          throw new TypeError(`${relative(srcDir, file)} must export a default function`)
        await module.default(server.app)
        // 项目的 seeder 只显示文件名，模块的显示相对 srcDir 的路径
        const label = dirname(file) === dirs.at(-1)
          ? basename(file)
          : relative(srcDir, file)
        consola.success(`Seeded ${label}`)
      }
    })
  },
})
