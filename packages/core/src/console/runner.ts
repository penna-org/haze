import type { Application } from '../application'
import type { CommandArgDef } from './args'
import type { CommandDefinition, DiscoveredCommand } from './command'
import process from 'node:process'
import { colors } from '../colors'
import { CommandArgumentError, parseCommandArgs } from './args'
import { createCommandContext } from './command'

export interface RunCommandOptions {
  /** 命令名（错误信息与 ctx.name），默认取定义里的 name */
  name?: string
  /** 用法中显示的命令前缀，默认 `haze` */
  bin?: string
}

/**
 * 解析参数并执行命令，返回退出码：run() 返回的数字，否则为 0；
 * 参数错误时打印用法并返回 1，run() 抛错时记录错误并返回 1
 */
export async function runCommand(app: Application, command: CommandDefinition<any>, argv: string[], options: RunCommandOptions = {}): Promise<number> {
  const name = options.name ?? command.name ?? 'command'
  let args
  try {
    args = parseCommandArgs(argv, command.args)
  }
  catch (error) {
    if (!(error instanceof CommandArgumentError))
      throw error
    console.error(`${renderCommandUsage(name, command, options.bin)}\n`)
    console.error(error.message)
    return 1
  }
  try {
    const code = await command.run(args, createCommandContext(app, name, argv))
    return typeof code === 'number'
      ? code
      : 0
  }
  catch (error) {
    app.logger.error(`Command "${name}" failed`, error)
    return 1
  }
}

/** 单个命令的用法（与 citty 的帮助格式相近） */
export function renderCommandUsage(name: string, command: CommandDefinition<any>, bin = 'haze'): string {
  const entries = Object.entries(command.args as Record<string, CommandArgDef>)
  const usage = [`${bin} ${name}`]
  const positionals: Array<[string, string]> = []
  const flags: Array<[string, string]> = []
  for (const [key, def] of entries) {
    if (def.type === 'positional') {
      const label = key.toUpperCase()
      const required = def.required !== false && def.default === undefined
      usage.push(required
        ? `<${label}>`
        : `[${label}]`)
      positionals.push([
        label,
        describe(def, required),
      ])
      continue
    }
    const aliases = typeof def.alias === 'string'
      ? [def.alias]
      : def.alias ?? []
    const hint = def.type === 'boolean'
      ? ''
      : def.type === 'enum'
        ? `=<${def.options.join('|')}>`
        : `=<${def.valueHint ?? kebab(key)}>`
    flags.push([
      [
        ...aliases.map(alias => `-${alias}`),
        `--${kebab(key)}`,
      ].join(', ') + hint,
      describe(def, Boolean(def.required) && def.default === undefined),
    ])
  }
  const lines = [
    colors.gray(command.description ?? name),
    '',
    `${colors.bold('USAGE')} ${usage.join(' ')}${flags.length
      ? ' [OPTIONS]'
      : ''}`,
  ]
  for (const [title, rows] of [
    ['ARGUMENTS', positionals],
    ['OPTIONS', flags],
  ] as const) {
    if (!rows.length)
      continue
    const width = Math.max(...rows.map(([label]) => label.length))
    lines.push('', colors.bold(title), '', ...rows.map(([label, text]) => `  ${label.padEnd(width)}  ${text}`.trimEnd()))
  }
  return lines.join('\n')
}

/** 命令列表：`name  description` */
export function renderCommandList(commands: DiscoveredCommand[]): string {
  const visible = commands.filter(item => !item.command.hidden)
  if (!visible.length)
    return 'No commands (app/command/*.ts)'
  const width = Math.max(...visible.map(item => item.name.length))
  return visible.map(item => `  ${item.name.padEnd(width)}  ${item.command.description ?? ''}`.trimEnd()).join('\n')
}

/**
 * 生产入口（worker.mjs command）使用：`<name> [args]` 执行命令，`<name> --help` 打印用法，不带名称时列出命令。
 * 返回退出码
 */
export async function runConsole(app: Application, commands: DiscoveredCommand[], argv: string[], bin = 'worker.mjs command'): Promise<number> {
  const [name, ...rest] = argv
  if (!name || name === '--help' || name === '-h' || name === 'list') {
    process.stdout.write(`${colors.bold('COMMANDS')}\n\n${renderCommandList(commands)}\n\nUse ${bin} <command> --help for more information about a command.\n`)
    return 0
  }
  const found = commands.find(item => item.name === name)
  if (!found) {
    console.error(`${renderCommandList(commands)}\n\nUnknown command ${name}`)
    return 1
  }
  // 命令自己定义了 help 参数时不拦截
  if ((rest.includes('--help') && !('help' in found.command.args)) || (rest.includes('-h') && !hasAlias(found.command, 'h'))) {
    process.stdout.write(`${renderCommandUsage(name, found.command, bin)}\n`)
    return 0
  }
  return runCommand(app, found.command, rest, { name, bin })
}

function hasAlias(command: CommandDefinition<any>, alias: string): boolean {
  return Object.entries(command.args as Record<string, CommandArgDef>).some(([key, def]) =>
    key === alias || (def.type !== 'positional' && ([] as string[]).concat(def.alias ?? []).includes(alias)))
}

function describe(def: CommandArgDef, required: boolean): string {
  return [
    def.description,
    required && colors.gray('(Required)'),
    def.default !== undefined && colors.gray(`(Default: ${def.default})`),
  ].filter(Boolean).join(' ')
}

function kebab(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()
}
