import { existsSync, readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { camelCase, kebabCase, parseName, plural } from './naming'

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
    hint: v => `触发：await ${v.className}.emit({ ... })；监听：think-h3 make:listener <Name>`,
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
    hint: v => `投递：await ${v.className}.dispatch({ ... })；消费：think-h3 queue:work`,
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
    hint: () => '运行：think-h3 test',
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
  seeder: {
    description: '数据填充',
    suffix: 'Seeder',
    dir: 'database/seeders',
    base: 'src',
    file: 'kebab',
    flat: true,
    stub: 'seeder',
    hint: () => '运行：think-h3 db:seed',
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
}

export interface MakeOptions {
  root: string
  srcDir: string
  kind: KindName
  name: string
  force?: boolean
  /** 使用的 stub 变体，例如 controller.resource */
  variant?: string
  /** 多应用：生成到 app/<app>/ 下 */
  app?: string
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
  const vars: StubVariables = {
    name,
    className: name + (kind.file === 'class'
      ? kind.suffix
      : ''),
    camelName: camelCase(name),
    kebabName: kebabCase(name),
    envName: kebabCase(name).replace(/-/g, '_').toUpperCase(),
    routePath: plural(kebabCase(name)),
  }

  const fileName = kind.file === 'class'
    ? vars.className
    : kind.file === 'camel'
      ? vars.camelName
      : vars.kebabName
  const base = kind.base === 'root'
    ? options.root
    : options.srcDir
  // 多应用：app/controller → app/<app>/controller，config → app/<app>/config
  const kindDir = options.app && kind.base === 'src'
    ? `app/${kebabCase(options.app)}/${kind.dir.replace(/^app\//, '')}`
    : kind.dir
  const file = join(base, kindDir, dir, fileName + (kind.ext ?? '.ts'))
  if (existsSync(file) && !options.force)
    throw new Error(`${file} already exists. Use --force to overwrite.`)

  const stubName = options.variant ?? kind.stub
  const { content, custom } = readStub(options.root, stubName)
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, render(content, vars))
  return {
    file,
    stub: stubName,
    custom,
    hint: options.app
      ? kind.hint?.(vars)?.replace('route/*.ts', `app/${kebabCase(options.app)}/route/*.ts`)
      : kind.hint?.(vars),
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
  name: string
  /** 表名，默认为名称的复数下划线形式（OrderItem → order_items） */
  table?: string
  dialect?: Dialect
  softDelete?: boolean
  app?: string
  force?: boolean
}

/** 生成模型（app/model）与对应的 drizzle 表结构（database/schema，已存在时跳过） */
export async function makeModel(options: MakeModelOptions): Promise<{ model: string, schema?: string, hint: string }> {
  const { dir, name } = parseName(options.name, 'Model')
  const tableName = options.table ?? plural(kebabCase(name)).replace(/-/g, '_')
  const vars = {
    name,
    className: name,
    tableName,
    tableVar: camelCase(tableName),
    softDelete: String(options.softDelete ?? false),
  }
  const modelDir = options.app
    ? `app/${kebabCase(options.app)}/model`
    : 'app/model'
  const model = join(options.srcDir, modelDir, dir, `${name}.ts`)
  if (existsSync(model) && !options.force)
    throw new Error(`${model} already exists. Use --force to overwrite.`)

  // MongoDB 没有表结构文件，模型中声明文档类型
  const mongo = options.dialect === 'mongodb'
  const schema = join(options.srcDir, 'database/schema', `${tableName}.ts`)
  const writeSchema = !mongo && !existsSync(schema)
  await mkdir(dirname(model), { recursive: true })
  await writeFile(model, render(readStub(options.root, mongo ? 'model.mongodb' : 'model').content, vars as unknown as StubVariables))
  if (writeSchema) {
    await mkdir(dirname(schema), { recursive: true })
    await writeFile(schema, render(readStub(options.root, `schema.${options.dialect ?? 'sqlite'}`).content, vars as unknown as StubVariables))
  }
  return {
    model,
    schema: writeSchema ? schema : undefined,
    hint: mongo
      ? 'MongoDB 无需迁移；索引可通过 (await Mongo.db()).collection(...).createIndex() 管理'
      : '修改表结构后运行：think-h3 db:generate && think-h3 db:migrate',
  }
}

export function render(content: string, vars: StubVariables): string {
  return content.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, key: string) => (vars as unknown as Record<string, string>)[key] ?? match)
}
