import type { DevServer } from '@hazejs/vite'
import type { ArgsDef, CommandDef } from 'citty'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { createDevServer, loadHazeConfig } from '@hazejs/vite'
import { defineCommand } from 'citty'
import { consola } from 'consola'
import { resolveRoot, rootArg } from '../args'

type Core = typeof import('@hazejs/core')

const SOURCE_RE = /\.[cm]?[jt]s$/

export interface UserCommands {
  commands: Record<string, CommandDef<any>>
  /** 释放应用与开发服务器（未加载时为空操作） */
  close: () => Promise<void>
}

/**
 * app/command 与模块的自定义命令。只在需要时加载：第一个参数不是内置命令（自定义命令或未知命令），
 * 或未指定命令（打印帮助）。加载时在开发服务器的模块图中启动应用（与 queue:work 相同），命令共用这个应用。
 */
export async function loadUserCommands(argv: string[], builtin: Set<string>): Promise<UserCommands> {
  const none: UserCommands = {
    commands: {},
    close: async () => {},
  }
  const first = argv.find(arg => !arg.startsWith('-'))
  if ((first && builtin.has(first)) || (argv.length === 1 && ['--version', '-v'].includes(argv[0])))
    return none
  const root = resolveRoot(rootOf(argv))
  if (!existsSync(root))
    return none
  const { srcDir } = await loadHazeConfig(root)
  // 没有 app/command、本地模块的命令与 config/modules.ts（模块包可能带命令）时不启动应用
  const moduleDirs = existsSync(join(srcDir, 'modules'))
    ? readdirSync(join(srcDir, 'modules')).map(name => join(srcDir, 'modules', name, 'app/command'))
    : []
  if (![
    join(srcDir, 'app/command'),
    ...moduleDirs,
  ].some(dir => hasSources(dir)) && !hasSources(join(srcDir, 'config'), /^modules\.[cm]?[jt]s$/)) {
    return none
  }

  let server: DevServer | undefined
  let closed = false
  const close = async (): Promise<void> => {
    if (closed)
      return
    closed = true
    await server?.close()
  }
  try {
    server = await createDevServer({ root, listen: false })
    const core = await server.import<Core>('@hazejs/core')
    if (!server.app)
      throw new Error('Application failed to start')
    const commands: Record<string, CommandDef<any>> = {}
    for (const { name, command, file, module } of await server.app.commands()) {
      if (builtin.has(name)) {
        consola.warn(`${module
          ? `module "${module}" command ${file ?? name}`
          : `app/command/${file}`} is ignored: "${name}" is a built-in command`)
        continue
      }
      commands[name] = toCitty(name, command, server, core, close)
    }
    return { commands, close }
  }
  catch (error) {
    consola.warn('Failed to load app/command', error)
    await close()
    return none
  }
}

/** 包装为 citty 命令：参数定义直接复用（帮助与校验由 citty 完成），执行交给 core 的 runCommand */
function toCitty(name: string, command: Awaited<ReturnType<Core['collectCommands']>>[number]['command'], server: DevServer, core: Core, close: () => Promise<void>): CommandDef<any> {
  const ownsRoot = 'root' in command.args
  return defineCommand({
    meta: {
      name,
      description: command.description,
      hidden: command.hidden,
    },
    args: {
      ...command.args as ArgsDef,
      ...(!ownsRoot && rootArg),
    },
    async run({ rawArgs }) {
      try {
        if (!server.app)
          throw new Error('Application failed to start')
        process.exitCode = await core.runCommand(server.app, command, ownsRoot
          ? rawArgs
          : withoutRoot(rawArgs), { name })
      }
      finally {
        await close()
      }
    },
  })
}

/** 从参数中读取 --root（自定义命令在 citty 解析之前就要定位项目） */
function rootOf(argv: string[]): string {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--root')
      return argv[i + 1] ?? '.'
    if (argv[i].startsWith('--root='))
      return argv[i].slice('--root='.length)
  }
  return '.'
}

function withoutRoot(argv: string[]): string[] {
  const result: string[] = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--root')
      i++
    else if (!argv[i].startsWith('--root='))
      result.push(argv[i])
  }
  return result
}

/** 目录（含子目录）下是否有源码文件 */
function hasSources(dir: string, pattern = SOURCE_RE): boolean {
  if (!existsSync(dir))
    return false
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .some(file => pattern.test(file) && !file.endsWith('.d.ts'))
}
