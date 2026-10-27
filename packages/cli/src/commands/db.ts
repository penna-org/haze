import type { DevServer } from '@think-h3/vite'
import { spawn } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import process from 'node:process'
import { createDevServer, loadThinkConfig } from '@think-h3/vite'
import { defineCommand } from 'citty'
import { consola } from 'consola'
import { resolveRoot, rootArg } from '../args'
import { binOf } from '../resolve'

interface ConnectionConfig {
  driver: 'sqlite' | 'postgres' | 'pglite' | 'mysql'
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
  const { srcDir } = await loadThinkConfig(root)
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
  const dialect = config.driver === 'mysql'
    ? 'mysql'
    : config.driver === 'sqlite'
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

const connectionArg = {
  connection: { type: 'string', alias: 'c', description: '连接名（默认 config/database.ts 中的 default）' },
} as const

export const generateCommand = defineCommand({
  meta: { name: 'db:generate', description: '根据 database/schema 的表结构变化生成迁移（drizzle-kit）' },
  args: {
    ...rootArg,
    ...connectionArg,
    name: { type: 'string', description: '迁移名称' },
    custom: { type: 'boolean', description: '生成空白迁移，手写 SQL', default: false },
  },
  async run({ args }) {
    const root = resolveRoot(args.root)
    const target = await withApp(root, async (_server, database, srcDir) => targetOf(database, srcDir, args.connection))
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
    await withApp(root, async (server, database, srcDir) => {
      const orm = await server.import<typeof import('@think-h3/orm')>('@think-h3/orm')
      const names = args.all
        ? Object.keys(database.connections)
        : [args.connection ?? database.default]
      for (const name of names) {
        const target = targetOf(database, srcDir, name)
        if (!existsSync(join(target.migrations, 'meta', '_journal.json'))) {
          consola.warn(`[${name}] no migrations in ${relative(root, target.migrations)}, run think-h3 db:generate first`)
          continue
        }
        await orm.migrate({ connection: name, folder: target.migrations })
        consola.success(`[${name}] migrated (${relative(root, target.migrations)})`)
      }
    })
  },
})

export const seedCommand = defineCommand({
  meta: { name: 'db:seed', description: '按文件名顺序执行 database/seeders 下的数据填充' },
  args: {
    ...rootArg,
    file: { type: 'string', description: '只执行指定文件（不含扩展名）' },
  },
  async run({ args }) {
    const root = resolveRoot(args.root)
    await withApp(root, async (server, _database, srcDir) => {
      const dir = join(srcDir, 'database', 'seeders')
      const files = existsSync(dir)
        ? readdirSync(dir).filter(file => /\.[cm]?[jt]s$/.test(file) && (!args.file || file.replace(/\.[^.]+$/, '') === args.file)).sort()
        : []
      if (!files.length) {
        consola.warn(`No seeders found in ${relative(root, dir)}`)
        return
      }
      for (const file of files) {
        const module = await server.import<{ default?: (app: unknown) => unknown }>(join(dir, file))
        if (typeof module.default !== 'function')
          throw new TypeError(`${file} must export a default function`)
        await module.default(server.app)
        consola.success(`Seeded ${file}`)
      }
    })
  },
})
