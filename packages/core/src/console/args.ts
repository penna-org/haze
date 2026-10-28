/**
 * 命令参数定义与解析，与 citty 的 args 写法兼容（haze 命令行直接复用这些定义生成帮助）。
 * 生产产物（worker.mjs command）不依赖 citty，由这里解析，规则与 citty 保持一致。
 */

interface BaseArgDef<V> {
  description?: string
  /** 帮助中显示的取值提示，例如 `--to=<email>` */
  valueHint?: string
  alias?: string | string[]
  default?: V
  required?: boolean
}

export interface BooleanArgDef extends BaseArgDef<boolean> {
  type: 'boolean'
  /** `--no-<name>` 的说明 */
  negativeDescription?: string
}

export interface StringArgDef extends BaseArgDef<string> {
  type: 'string'
}

export interface EnumArgDef extends BaseArgDef<string> {
  type: 'enum'
  options: readonly string[]
}

export interface PositionalArgDef extends Omit<BaseArgDef<string>, 'alias'> {
  type: 'positional'
}

export type CommandArgDef = BooleanArgDef | StringArgDef | EnumArgDef | PositionalArgDef
export type CommandArgsDef = Record<string, CommandArgDef>

type Resolved<T extends CommandArgDef, V> = T extends { default: any }
  ? V
  : T extends { required: true }
    ? V
    // citty 的约定：位置参数未写 required: false 时视为必填
    : T extends { type: 'positional' }
      ? T extends { required: false }
        ? V | undefined
        : V
      : V | undefined

// 未传入的布尔参数为 false
type ParsedArg<T extends CommandArgDef> = T extends { type: 'boolean' }
  ? boolean
  : T extends { type: 'enum', options: readonly (infer O)[] }
    ? Resolved<T, O>
    : Resolved<T, string>

/** 解析后的参数：每个定义一个字段，`_` 为全部位置参数（含未定义的） */
export type ParsedCommandArgs<A extends CommandArgsDef = CommandArgsDef> = { _: string[] } & { -readonly [K in keyof A]: ParsedArg<A[K]> }

/** 参数错误（缺少必填参数、枚举值无效等），命令行会打印用法并以退出码 1 结束 */
export class CommandArgumentError extends Error {
  override name = 'CommandArgumentError'
}

export function parseCommandArgs<A extends CommandArgsDef>(argv: readonly string[], defs: A = {} as A): ParsedCommandArgs<A> {
  const entries = Object.entries(defs)
  const flags = entries.filter(([, def]) => def.type !== 'positional')
  const result: Record<string, unknown> = {}
  const positionals: string[] = []

  /** 按名称（camel / kebab 都可）或别名查找定义 */
  const lookup = (name: string): [string, CommandArgDef] | undefined => {
    const camel = camelCase(name)
    return flags.find(([key, def]) => camelCase(key) === camel || toArray((def as { alias?: string | string[] }).alias).includes(name))
  }
  const set = (key: string, def: CommandArgDef | undefined, value: string | boolean): void => {
    if (!def) {
      result[camelCase(key)] = value
      return
    }
    result[key] = def.type === 'boolean'
      ? value !== false && value !== 'false'
      : value === true
        ? ''
        : value
  }

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (token === '--') {
      positionals.push(...argv.slice(i + 1))
      break
    }
    if (!token.startsWith('-') || token === '-') {
      positionals.push(token)
      continue
    }
    const long = token.startsWith('--')
    const body = token.slice(long ? 2 : 1)
    const eq = body.indexOf('=')
    const names = eq === -1
      ? body
      : body.slice(0, eq)
    const inline = eq === -1
      ? undefined
      : body.slice(eq + 1)
    // -abc：多个短别名（最后一个可以带值）
    const keys = long
      ? [names]
      : [...names]
    for (const [index, name] of keys.entries()) {
      const last = index === keys.length - 1
      const found = lookup(name)
      // --no-<name>：布尔参数取 false
      if (!found && long && name.startsWith('no-')) {
        const negated = lookup(name.slice(3))
        if (negated?.[1].type === 'boolean') {
          result[negated[0]] = false
          continue
        }
      }
      const [key, def] = found ?? [name, undefined]
      if (!last || def?.type === 'boolean' || (!def && inline === undefined)) {
        set(key, def, last && inline !== undefined
          ? inline
          : true)
        continue
      }
      if (inline !== undefined) {
        set(key, def, inline)
        continue
      }
      // 字符串参数取下一个不以 - 开头的值
      const next = argv[i + 1]
      if (next !== undefined && !next.startsWith('-')) {
        set(key, def, next)
        i++
      }
      else {
        set(key, def, '')
      }
    }
  }

  const queue = [...positionals]
  for (const [key, def] of entries) {
    if (def.type === 'positional') {
      const value = queue.shift()
      if (value !== undefined)
        result[key] = value
      else if (def.default !== undefined)
        result[key] = def.default
      else if (def.required !== false)
        throw new CommandArgumentError(`Missing required positional argument: ${key.toUpperCase()}`)
      continue
    }
    if (result[key] === undefined && def.default !== undefined)
      result[key] = def.default
    if (result[key] === undefined && def.type === 'boolean')
      result[key] = false
    if (def.type === 'enum' && result[key] !== undefined && !def.options.includes(result[key] as string))
      throw new CommandArgumentError(`Invalid value for --${key} (${String(result[key])}). Expected one of: ${def.options.join(', ')}`)
    if (def.required && result[key] === undefined)
      throw new CommandArgumentError(`Missing required argument: --${key}`)
  }
  result._ = positionals
  return result as ParsedCommandArgs<A>
}

function toArray(value: string | string[] | undefined): string[] {
  return value === undefined
    ? []
    : Array.isArray(value)
      ? value
      : [value]
}

function camelCase(value: string): string {
  return value.replace(/-+(.)/g, (_, char: string) => char.toUpperCase())
}
