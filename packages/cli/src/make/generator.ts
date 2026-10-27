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

export function render(content: string, vars: StubVariables): string {
  return content.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, key: string) => (vars as unknown as Record<string, string>)[key] ?? match)
}
