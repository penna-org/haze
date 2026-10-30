import { existsSync, readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { camelCase, commandName, kebabCase, parseName, plural } from './naming'

/** 内置 stub 目录：构建产物（dist/）与源码（src/make/）位于不同深度，向上查找 */
export const STUBS_DIR = ['../stubs', '../../stubs']
  .map(path => fileURLToPath(new URL(path, import.meta.url)))
  .find(dir => existsSync(dir))!

export interface MakeKind {
  description: string
  /** 类名后缀，例如 Controller */
  suffix: string
  /** 目标目录，相对 srcDir（tests 相对项目根） */
  dir: string
  base: 'src' | 'root'
  /** 文件名风格：类名 / kebab / camel */
  file: 'class' | 'kebab' | 'camel'
  /** 文件扩展名，默认 .ts */
  ext?: string
  /** 只按目录第一层自动发现（config/*.ts、route/*.ts），不允许子目录 */
  flat?: boolean
  /** 不区分应用（多应用的 --app 无效） */
  global?: boolean
  stub: string
  /** 生成后的提示 */
  hint?: (vars: StubVariables) => string
}

export const KINDS = {
  controller: {
    description: '控制器',
    suffix: 'Controller',
    dir: 'app/controller',
    base: 'src',
    file: 'class',
    stub: 'controller',
    hint: v => `在 route/*.ts 中注册：r.get('/${v.routePath}', [${v.className}, 'index'])`,
  },
  service: {
    description: '业务服务',
    suffix: 'Service',
    dir: 'app/service',
    base: 'src',
    file: 'class',
    stub: 'service',
  },
  repository: {
    description: '数据访问层',
    suffix: 'Repository',
    dir: 'app/repository',
    base: 'src',
    file: 'class',
    stub: 'repository',
  },
  middleware: {
    description: '中间件',
    suffix: '',
    dir: 'app/middleware',
    base: 'src',
    file: 'class',
    stub: 'middleware',
    hint: v => `在 config/middleware.ts 的 alias 中注册：${v.camelName}: ${v.className}`,
  },
  interceptor: {
    description: '出站拦截器',
    suffix: 'Interceptor',
    dir: 'app/interceptor',
    base: 'src',
    file: 'kebab',
    flat: true,
    stub: 'interceptor',
    hint: () => 'app/interceptor 下的拦截器按文件名顺序自动加载',
  },
  provider: {
    description: '服务提供者',
    suffix: 'Provider',
    dir: 'app/provider',
    base: 'src',
    file: 'class',
    stub: 'provider',
    hint: () => 'app/provider 下的提供者会被自动加载',
  },
  event: {
    description: '事件',
    suffix: '',
    dir: 'app/event',
    base: 'src',
    file: 'class',
    flat: true,
    stub: 'event',
    hint: v => `触发：await ${v.className}.emit({ ... })；监听：haze make:listener <Name>`,
  },
  listener: {
    description: '事件监听器',
    suffix: '',
    dir: 'app/listener',
    base: 'src',
    file: 'class',
    flat: true,
    stub: 'listener',
    hint: () => 'app/listener 下的监听器自动注册；把 import 的事件改为要监听的事件',
  },
  job: {
    description: '队列任务',
    suffix: '',
    dir: 'app/job',
    base: 'src',
    file: 'class',
    flat: true,
    stub: 'job',
    hint: v => `投递：await ${v.className}.dispatch({ ... })；消费：haze queue:work`,
  },
  policy: {
    description: '授权策略',
    suffix: 'Policy',
    dir: 'app/policy',
    base: 'src',
    file: 'class',
    flat: true,
    stub: 'policy',
    hint: v => `app/policy 下的策略自动注册：await ctx.authorize('update', ${v.camelName}) / .middleware('can:update,${v.name},id')`,
  },
  validate: {
    description: '请求校验',
    suffix: 'Schema',
    dir: 'app/validate',
    base: 'src',
    file: 'kebab',
    stub: 'validate',
  },
  test: {
    description: '测试',
    suffix: 'Test',
    dir: 'tests',
    base: 'root',
    file: 'kebab',
    ext: '.test.ts',
    stub: 'test',
    hint: () => '运行：haze test',
  },
  config: {
    description: '配置文件',
    suffix: 'Config',
    dir: 'config',
    base: 'src',
    file: 'camel',
    flat: true,
    stub: 'config',
    hint: v => `读取：config('${v.camelName}.enabled')`,
  },
  route: {
    description: '路由文件',
    suffix: 'Routes',
    dir: 'route',
    base: 'src',
    file: 'kebab',
    flat: true,
    stub: 'route',
  },
  command: {
    description: '自定义命令',
    suffix: '',
    dir: 'app/command',
    base: 'src',
    file: 'class',
    global: true,
    stub: 'command',
    hint: v => `运行：haze ${v.commandName}（生产环境：node dist/worker.mjs command ${v.commandName}）`,
  },
  mail: {
    description: '邮件',
    suffix: 'Mail',
    dir: 'app/mail',
    base: 'src',
    file: 'class',
    stub: 'mail',
    hint: v => `发送：await Mail.to(user.email).send(${v.className}, { name: user.name })；排队发送用 .queue(...)`,
  },
  view: {
    description: 'TSX 视图',
    suffix: '',
    dir: 'app/view',
    base: 'src',
    file: 'class',
    ext: '.tsx',
    global: true,
    stub: 'view',
    hint: v => `渲染：return ctx.view(<${v.className} title="..." />)，或按名称 ctx.view('<app/view 下的路径>', { title: '...' })`,
  },
  notification: {
    description: '通知',
    suffix: 'Notification',
    dir: 'app/notification',
    base: 'src',
    file: 'class',
    flat: true,
    stub: 'notification',
    hint: v => `发送：await notify(user, ${v.className}({ message: '...' }))；数据库渠道需要 haze make:notifications-table`,
  },
  channel: {
    description: '广播频道授权',
    suffix: '',
    dir: 'app/channel',
    base: 'src',
    file: 'kebab',
    flat: true,
    stub: 'channel',
    hint: v => `前端订阅：echo.private('${v.camelName}.1')；服务端：await broadcast({ channel: privateChannel('${v.camelName}.1'), event, data })`,
  },
  resource: {
    description: 'API 资源',
    suffix: 'Resource',
    dir: 'app/resource',
    base: 'src',
    file: 'class',
    stub: 'resource',
    hint: v => `返回：${v.className}.make(model) / ${v.className}.collection(await Model.paginate(page, 20))`,
  },
  seeder: {
    description: '数据填充',
    suffix: 'Seeder',
    dir: 'database/seeders',
    base: 'src',
    file: 'kebab',
    flat: true,
    stub: 'seeder',
    hint: () => '运行：haze db:seed',
  },
  factory: {
    description: '模型工厂',
    suffix: 'Factory',
    dir: 'database/factories',
    base: 'src',
    file: 'class',
    global: true,
    stub: 'factory',
    hint: v => `使用：await ${v.className}.count(3).create()（在数据填充与测试中；faker 需要 pnpm add -D @faker-js/faker）`,
  },
} satisfies Record<string, MakeKind>

export type KindName = keyof typeof KINDS

export interface StubVariables {
  name: string
  className: string
  camelName: string
  kebabName: string
  envName: string
  routePath: string
  /** 自定义命令名：SendReport → send:report，db/Cleanup → db:cleanup */
  commandName: string
  /** 模块目录前缀（`modules/blog/`，不在模块中时为空），工厂导入模型时使用 */
  modulePath?: string
  /** 名称中的子目录（`admin/`，没有时为空） */
  dirPath?: string
}

/** 写入前处理生成的代码（开启自动导入时去掉会被自动导入的 import） */
export type PostProcess = (code: string, file: string) => string

export interface MakeOptions {
  root: string
  srcDir: string
  postProcess?: PostProcess
  kind: KindName
  name: string
  force?: boolean
  /** 使用的 stub 变体，例如 controller.resource */
  variant?: string
  /** 多应用：生成到 app/<app>/ 下 */
  app?: string
  /** 本地模块：生成到 modules/<module>/ 下（需先 haze make:module） */
  module?: string
}

export interface MakeResult {
  file: string
  stub: string
  /** 是否使用了项目 stubs/ 下的自定义模板 */
  custom: boolean
  hint?: string
}

export async function make(options: MakeOptions): Promise<MakeResult> {
  const kind: MakeKind = KINDS[options.kind]
  const { dir, name } = parseName(options.name, kind.suffix)
  if (kind.flat && dir)
    throw new Error(`${kind.dir}/ 只自动加载第一层文件，${options.kind} 名称不能包含子目录：${options.name}`)
  if (kind.global && options.app)
    throw new Error(`${options.kind} 不区分应用，不支持 --app（统一放在 ${kind.dir}/）`)
  const moduleDir = options.module === undefined
    ? undefined
    : localModuleDir(options.srcDir, options.module, options.app)
  const vars: StubVariables = {
    name,
    className: name + (kind.file === 'class'
      ? kind.suffix
      : ''),
    camelName: camelCase(name),
    kebabName: kebabCase(name),
    envName: kebabCase(name).replace(/-/g, '_').toUpperCase(),
    routePath: plural(kebabCase(name)),
    commandName: commandName(dir, name),
    modulePath: moduleDir
      ? `${moduleDir}/`
      : '',
    dirPath: dir
      ? `${dir}/`
      : '',
  }

  const fileName = kind.file === 'class'
    ? vars.className
    : kind.file === 'camel'
      ? vars.camelName
      : vars.kebabName
  const base = kind.base === 'root'
    ? options.root
    : options.srcDir
  // 多应用：app/controller → app/<app>/controller，config → app/<app>/config；
  // 模块：目录结构与项目相同，整体位于 modules/<module>/ 下（测试为 modules/<module>/tests）
  const kindDir = options.app && kind.base === 'src'
    ? `app/${kebabCase(options.app)}/${kind.dir.replace(/^app\//, '')}`
    : kind.dir
  const file = moduleDir
    ? join(options.srcDir, moduleDir, kind.dir, dir, fileName + (kind.ext ?? '.ts'))
    : join(base, kindDir, dir, fileName + (kind.ext ?? '.ts'))
  if (existsSync(file) && !options.force)
    throw new Error(`${file} already exists. Use --force to overwrite.`)

  const stubName = options.variant ?? kind.stub
  const { content, custom } = readStub(options.root, stubName)
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, processed(options, render(content, vars), file))
  return {
    file,
    stub: stubName,
    custom,
    hint: moduleDir
      ? kind.hint?.(vars)?.replace(/(?<![\w/])(route\/\*\.ts|config\/middleware\.ts|app\/\w+|database\/seeders)/g, `${moduleDir}/$1`)
      : options.app
        ? kind.hint?.(vars)?.replace('route/*.ts', `app/${kebabCase(options.app)}/route/*.ts`)
        : kind.hint?.(vars),
  }
}

function processed(options: { postProcess?: PostProcess }, code: string, file: string): string {
  return options.postProcess
    ? options.postProcess(code, file)
    : code
}

/** `--module <name>` 对应的目录（相对 srcDir），模块需已存在 */
function localModuleDir(srcDir: string, name: string, app: string | undefined): string {
  if (app)
    throw new Error('--app 与 --module 不能同时使用（模块挂载到哪个应用由 config/modules.ts 的 app 决定）')
  const dir = `modules/${kebabCase(name)}`
  if (!existsSync(join(srcDir, dir)))
    throw new Error(`Module "${name}" not found (${dir}). Create it first: haze make:module ${name}`)
  return dir
}

export interface MakeModuleOptions {
  root: string
  srcDir: string
  postProcess?: PostProcess
  name: string
  force?: boolean
}

/** 本地模块骨架：module.ts、路由、控制器、默认配置与测试 */
export async function makeModule(options: MakeModuleOptions): Promise<{ files: string[], hint: string }> {
  const { dir, name } = parseName(options.name, 'Module')
  if (dir)
    throw new Error(`Module names cannot contain directories: ${options.name}`)
  const vars: StubVariables = {
    name,
    className: name,
    camelName: camelCase(name),
    kebabName: kebabCase(name),
    envName: kebabCase(name).replace(/-/g, '_').toUpperCase(),
    routePath: plural(kebabCase(name)),
    commandName: commandName('', name),
  }
  const moduleDir = join(options.srcDir, 'modules', vars.kebabName)
  if (existsSync(moduleDir) && !options.force)
    throw new Error(`${moduleDir} already exists. Use --force to overwrite.`)
  const files: Array<[stub: string, path: string]> = [
    ['module', 'module.ts'],
    ['module.route', `route/${vars.kebabName}.ts`],
    ['module.controller', `app/controller/${name}Controller.ts`],
    ['module.config', `config/${vars.camelName}.ts`],
    ['module.test', `tests/${vars.kebabName}.test.ts`],
  ]
  const written: string[] = []
  for (const [stub, path] of files) {
    const file = join(moduleDir, path)
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, processed(options, render(readStub(options.root, stub).content, vars), file))
    written.push(file)
  }
  return {
    files: written,
    hint: `模块默认启用（config/modules.ts 的 local.${vars.kebabName} 可关闭或改前缀）；在模块中生成代码：haze make:controller Post --module ${vars.kebabName}`,
  }
}

/** 优先使用项目根目录 stubs/<name>.stub，便于团队定制 */
export function readStub(root: string, stubName: string): { content: string, custom: boolean } {
  const custom = join(root, 'stubs', `${stubName}.stub`)
  if (existsSync(custom)) {
    return {
      content: readFileSync(custom, 'utf8'),
      custom: true,
    }
  }
  const builtin = join(STUBS_DIR, `${stubName}.stub`)
  if (!existsSync(builtin))
    throw new Error(`Stub "${stubName}" not found`)
  return {
    content: readFileSync(builtin, 'utf8'),
    custom: false,
  }
}

export type Dialect = 'sqlite' | 'postgres' | 'mysql' | 'mongodb'

export interface MakeModelOptions {
  root: string
  srcDir: string
  postProcess?: PostProcess
  name: string
  /** 表名，默认为名称的复数下划线形式（OrderItem → order_items） */
  table?: string
  dialect?: Dialect
  softDelete?: boolean
  app?: string
  /** 本地模块：模型与表结构生成到 modules/<module>/ 下 */
  module?: string
  force?: boolean
}

/** 生成模型（app/model）与对应的 drizzle 表结构（database/schema，已存在时跳过） */
export async function makeModel(options: MakeModelOptions): Promise<{ model: string, schema?: string, hint: string }> {
  const { dir, name } = parseName(options.name, 'Model')
  const tableName = options.table ?? plural(kebabCase(name)).replace(/-/g, '_')
  const moduleDir = options.module === undefined
    ? ''
    : `${localModuleDir(options.srcDir, options.module, options.app)}/`
  const vars = {
    name,
    className: name,
    tableName,
    tableVar: camelCase(tableName),
    softDelete: String(options.softDelete ?? false),
    schemaDir: `${moduleDir}database/schema`,
  }
  const modelDir = options.app
    ? `app/${kebabCase(options.app)}/model`
    : `${moduleDir}app/model`
  const model = join(options.srcDir, modelDir, dir, `${name}.ts`)
  if (existsSync(model) && !options.force)
    throw new Error(`${model} already exists. Use --force to overwrite.`)

  // MongoDB 没有表结构文件，模型中声明文档类型
  const mongo = options.dialect === 'mongodb'
  const schema = join(options.srcDir, vars.schemaDir, `${tableName}.ts`)
  const writeSchema = !mongo && !existsSync(schema)
  await mkdir(dirname(model), { recursive: true })
  await writeFile(model, processed(options, render(readStub(options.root, mongo ? 'model.mongodb' : 'model').content, vars as unknown as StubVariables), model))
  if (writeSchema) {
    await mkdir(dirname(schema), { recursive: true })
    await writeFile(schema, render(readStub(options.root, `schema.${options.dialect ?? 'sqlite'}`).content, vars as unknown as StubVariables))
  }
  return {
    model,
    schema: writeSchema ? schema : undefined,
    hint: mongo
      ? 'MongoDB 无需迁移；索引可通过 (await Mongo.db()).collection(...).createIndex() 管理'
      : options.module
        ? `修改表结构后运行：haze db:generate --module ${kebabCase(options.module)} && haze db:migrate`
        : '修改表结构后运行：haze db:generate && haze db:migrate',
  }
}

export function render(content: string, vars: StubVariables): string {
  return content.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, key: string) => (vars as unknown as Record<string, string>)[key] ?? match)
}

export interface MakeNotificationsTableOptions {
  root: string
  srcDir: string
  dialect?: Exclude<Dialect, 'mongodb'>
  force?: boolean
}

/** 通知的 database 渠道使用的表结构（database/schema/notifications.ts） */
export async function makeNotificationsTable(options: MakeNotificationsTableOptions): Promise<{ schema: string, hint: string }> {
  const schema = join(options.srcDir, 'database/schema', 'notifications.ts')
  if (existsSync(schema) && !options.force)
    throw new Error(`${schema} already exists. Use --force to overwrite.`)
  await mkdir(dirname(schema), { recursive: true })
  await writeFile(schema, readStub(options.root, `notifications.${options.dialect ?? 'sqlite'}`).content)
  return {
    schema,
    hint: '运行 haze db:generate && haze db:migrate，然后在 config/notification.ts 中设置 channels.database.store: () => databaseNotificationStore(notifications)',
  }
}

export interface MakeAuthTablesOptions {
  root: string
  srcDir: string
  dialect?: Exclude<Dialect, 'mongodb'>
  force?: boolean
}

/** 认证扩展的表结构（database/schema/auth.ts）：个人访问令牌、找回密码、两步验证、通行密钥 */
export async function makeAuthTables(options: MakeAuthTablesOptions): Promise<{ schema: string, hint: string }> {
  const schema = join(options.srcDir, 'database/schema', 'auth.ts')
  if (existsSync(schema) && !options.force)
    throw new Error(`${schema} already exists. Use --force to overwrite.`)
  await mkdir(dirname(schema), { recursive: true })
  await writeFile(schema, readStub(options.root, `auth-tables.${options.dialect ?? 'sqlite'}`).content)
  return {
    schema,
    hint: '运行 haze db:generate && haze db:migrate，然后在 config/auth.ts 中使用 databaseTokenStore(personalAccessTokens) 等存储（见文档 API 令牌 / 两步验证）',
  }
}

export interface MakeQueueTablesOptions {
  root: string
  srcDir: string
  dialect?: Exclude<Dialect, 'mongodb'>
  force?: boolean
}

/** 数据库队列的表结构（database/schema/queue.ts）：任务表 jobs 与失败任务表 failed_jobs */
export async function makeQueueTables(options: MakeQueueTablesOptions): Promise<{ schema: string, hint: string }> {
  const schema = join(options.srcDir, 'database/schema', 'queue.ts')
  if (existsSync(schema) && !options.force)
    throw new Error(`${schema} already exists. Use --force to overwrite.`)
  await mkdir(dirname(schema), { recursive: true })
  await writeFile(schema, readStub(options.root, `queue-tables.${options.dialect ?? 'sqlite'}`).content)
  return {
    schema,
    hint: '运行 haze db:migrate，然后在 config/queue.ts 中添加 connections.database: { driver: \'database\' }（需要 databaseProvider()），用 haze queue:work --connection database 消费',
  }
}
