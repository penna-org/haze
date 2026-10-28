import type { Application } from '../application'
import type { Logger } from '../logger'
import type { MaybePromise, ModuleRecord } from '../utils'
import type { CommandArgsDef, ParsedCommandArgs } from './args'
import { consola } from 'consola'
import { unwrapDefault } from '../utils'

const kCommand = Symbol.for('hazejs.command')

type PromptOptions = NonNullable<Parameters<typeof consola.prompt>[1]>

export interface CommandContext {
  /** 已启动的应用 */
  app: Application
  logger: Logger
  /** 命令名，例如 `send:report` */
  name: string
  /** 命令名之后的原始参数 */
  rawArgs: string[]
  /** consola 的交互式提问（text / confirm / select / multiselect），取消时抛错 */
  prompt: <T extends PromptOptions>(message: string, options?: T) => ReturnType<typeof consola.prompt<T>>
  confirm: (message: string, initial?: boolean) => Promise<boolean>
  ask: (message: string, options?: { default?: string, placeholder?: string }) => Promise<string>
  choice: <T extends string>(message: string, options: readonly T[], initial?: T) => Promise<T>
}

export interface CommandOptions<A extends CommandArgsDef> {
  /** 命令名，默认由文件路径推导：`SendReport.ts` → `send:report`、`db/Cleanup.ts` → `db:cleanup` */
  name?: string
  description?: string
  /** 参数定义（与 citty 相同）：positional / string / boolean / enum，支持 default / alias / required */
  args?: A
  /** 在 `haze --help` 中隐藏 */
  hidden?: boolean
  /** 返回数字作为退出码；抛出异常时退出码为 1 */
  run: (args: ParsedCommandArgs<A>, ctx: CommandContext) => MaybePromise<number | void>
}

export interface CommandDefinition<A extends CommandArgsDef = CommandArgsDef> extends CommandOptions<A> {
  readonly [kCommand]: true
  args: A
}

/**
 * 定义命令（app/command/**\/*.ts 自动发现）：`haze <name> [args]` 运行，
 * 生产环境用 `node dist/worker.mjs command <name> [args]`。
 *
 * ```ts
 * export default defineCommand({
 *   description: '发送日报',
 *   args: {
 *     date: { type: 'positional', required: false, description: '日期' },
 *     dryRun: { type: 'boolean', alias: 'd', description: '只打印不发送' },
 *   },
 *   async run(args, ctx) {
 *     ctx.logger.info(`report for ${args.date ?? 'today'}`)
 *   },
 * })
 * ```
 */
export function defineCommand<const A extends CommandArgsDef = Record<never, never>>(options: CommandOptions<A>): CommandDefinition<A> {
  return {
    [kCommand]: true,
    ...options,
    args: options.args ?? {} as A,
  }
}

export function isCommand(value: unknown): value is CommandDefinition<any> {
  return typeof value === 'object' && value !== null && kCommand in value
}

export interface DiscoveredCommand {
  name: string
  command: CommandDefinition<any>
  /** 来源文件（相对 app/command），手动传入的命令为 undefined */
  file?: string
}

const COMMAND_PATH_RE = /(?:^|\/)app\/command\/(.+)\.[cm]?[jt]sx?$/

/**
 * 由文件路径推导命令名：顶层文件按第一个单词分组（`SendReport` → `send:report`，`Inspire` → `inspire`），
 * 子目录作为分组（`db/Cleanup` → `db:cleanup`，`db/PruneOld` → `db:prune-old`），末尾的 Command 后缀会去掉
 */
export function commandName(file: string): string {
  const path = COMMAND_PATH_RE.exec(file)?.[1] ?? file.replace(/\.[cm]?[jt]sx?$/, '')
  const segments = path.split('/').filter(Boolean)
  let last = segments.pop()!
  if (last.endsWith('Command') && last !== 'Command')
    last = last.slice(0, -'Command'.length)
  const leaf = kebabCase(last)
  return segments.length
    ? [
        ...segments.map(kebabCase),
        leaf,
      ].join(':')
    : leaf.replace('-', ':')
}

/**
 * 收集命令：`import.meta.glob` 记录（app/command 下，键为文件路径；值可以是模块或按需加载的函数）或命令数组。
 * 默认导出不是 defineCommand() 的模块（例如命令共用的辅助函数）会被忽略
 */
export async function collectCommands(input: ModuleRecord | Array<CommandDefinition<any>> | undefined): Promise<DiscoveredCommand[]> {
  const found: DiscoveredCommand[] = []
  if (Array.isArray(input)) {
    for (const command of input) {
      if (!command.name)
        throw new Error('Commands passed as an array must have a name')
      found.push({ name: command.name, command })
    }
  }
  else {
    for (const [path, entry] of Object.entries(input ?? {})) {
      const mod = typeof entry === 'function' && !isCommand(entry)
        ? await (entry as () => Promise<unknown>)()
        : entry
      const command = unwrapDefault<unknown>(mod)
      if (!isCommand(command))
        continue
      found.push({
        name: command.name ?? commandName(path),
        command,
        file: COMMAND_PATH_RE.exec(path)?.[1] ?? path,
      })
    }
  }
  const seen = new Map<string, DiscoveredCommand>()
  for (const item of found) {
    const previous = seen.get(item.name)
    if (previous)
      throw new Error(`Duplicate command "${item.name}" (${previous.file ?? 'inline'} and ${item.file ?? 'inline'})`)
    seen.set(item.name, item)
  }
  return found.sort((a, b) => a.name.localeCompare(b.name))
}

/** 构造命令上下文（交互式提问基于 consola.prompt，取消时抛错） */
export function createCommandContext(app: Application, name: string, rawArgs: string[]): CommandContext {
  const prompt = (async (message: string, options?: PromptOptions) =>
    consola.prompt(message, { ...options, cancel: 'reject' } as PromptOptions)) as CommandContext['prompt']
  return {
    app,
    logger: app.logger,
    name,
    rawArgs,
    prompt,
    confirm: async (message, initial) => Boolean(await consola.prompt(message, {
      type: 'confirm',
      initial,
      cancel: 'reject',
    })),
    ask: async (message, options = {}) => String(await consola.prompt(message, {
      type: 'text',
      default: options.default,
      placeholder: options.placeholder,
      cancel: 'reject',
    })),
    choice: async (message, options, initial) => await consola.prompt(message, {
      type: 'select',
      options: [...options],
      initial,
      cancel: 'reject',
    }) as unknown as typeof options[number],
  }
}

function kebabCase(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[_\s]+/g, '-')
    .toLowerCase()
}
