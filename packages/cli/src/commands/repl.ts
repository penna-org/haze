import type { DevServer } from '@hazejs/vite'
import type { REPLEval } from 'node:repl'
import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { start } from 'node:repl'
import { inspect } from 'node:util'
import { createDevServer, loadHazeConfig } from '@hazejs/vite'
import { defineCommand } from 'citty'
import { consola } from 'consola'
import { resolveRoot, rootArg } from '../args'
import { findPackage } from '../resolve'

type Core = typeof import('@hazejs/core')

const SOURCE_RE = /\.[cm]?[jt]s$/
/** 注入 REPL 的门面（core 中存在才注入） */
const FACADES = [
  'Cache',
  'Queue',
  'Events',
  'Storage',
  'Mail',
] as const

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (...args: string[]) => (...values: unknown[]) => Promise<unknown>

export default defineCommand({
  meta: { name: 'repl', description: '交互式命令行：已启动的应用、门面与 app/model 下的模型（支持顶层 await）' },
  args: {
    ...rootArg,
    eval: { type: 'string', alias: 'e', description: '执行一段代码并打印结果后退出（非交互）' },
  },
  async run({ args }) {
    const root = resolveRoot(args.root)
    const { srcDir } = await loadHazeConfig(root)
    const server = await createDevServer({ root, listen: false })
    if (!server.app) {
      await server.close()
      throw new Error('Application failed to start')
    }
    if (args.eval !== undefined) {
      try {
        process.exitCode = await evaluate(args.eval, await replContext(server, root, srcDir))
      }
      finally {
        await server.close()
      }
      return
    }
    await interactive(server, root, srcDir)
  },
})

/** REPL 上下文：app、config、inject、门面、Db（安装了 @hazejs/orm 时）与模型类 */
async function replContext(server: DevServer, root: string, srcDir: string): Promise<Record<string, unknown>> {
  const core = await server.import<Core>('@hazejs/core')
  const context: Record<string, unknown> = {
    app: server.app,
    config: core.config,
    inject: core.inject,
    useApp: core.useApp,
  }
  for (const name of FACADES) {
    if (name in core)
      context[name] = core[name]
  }
  if (findPackage(root, '@hazejs/orm')) {
    try {
      context.Db = (await server.import<{ Db: unknown }>('@hazejs/orm')).Db
    }
    catch (error) {
      consola.warn('Failed to load @hazejs/orm', error)
    }
  }
  for (const file of modelFiles(join(srcDir, 'app/model'))) {
    try {
      const mod = await server.import<Record<string, unknown>>(file)
      for (const [key, value] of Object.entries(mod)) {
        if (isClass(value)) {
          context[key === 'default'
            ? value.name
            : key] = value
        }
      }
    }
    catch (error) {
      consola.warn(`Failed to load ${file}`, error)
    }
  }
  return context
}

/** 非交互：先按表达式求值（打印结果），语法不成立时按语句块执行（用 return 输出结果） */
async function evaluate(code: string, context: Record<string, unknown>): Promise<number> {
  const names = Object.keys(context)
  let fn: (...values: unknown[]) => Promise<unknown>
  try {
    fn = new AsyncFunction(...names, `return (\n${code}\n)`)
  }
  catch {
    fn = new AsyncFunction(...names, code)
  }
  try {
    const value = await fn(...names.map(name => context[name]))
    if (value !== undefined)
      console.log(format(value, Boolean(process.stdout.isTTY)))
    return 0
  }
  catch (error) {
    console.error(error)
    return 1
  }
}

async function interactive(server: DevServer, root: string, srcDir: string): Promise<void> {
  const colors = Boolean(process.stdout.isTTY) && !('NO_COLOR' in process.env)
  // 先准备好上下文再开始读取输入（管道输入会被立即消费）
  const initial = await replContext(server, root, srcDir)
  consola.info(`Available: ${Object.keys(initial).join(', ')}`)
  const repl = start({
    prompt: 'haze> ',
    useColors: colors,
    ignoreUndefined: true,
    writer: value => format(value, colors),
  })
  // 逐条求值：管道输入时 Node 不等待上一条的顶层 await；输入结束（或 .exit）时也要等求值完成再关闭应用
  const evaluate = repl.eval
  let pending = Promise.resolve()
  ;(repl as { eval: REPLEval }).eval = (code, context, file, callback) => {
    pending = pending.then(() => new Promise<void>(resolve => evaluate.call(repl, code, context, file, (error, result) => {
      callback(error, result)
      resolve()
    })))
  }
  const exited = new Promise<void>(resolve => repl.once('exit', resolve)).then(() => pending)
  const assign = (context: Record<string, unknown>): void => {
    for (const [key, value] of Object.entries(context)) {
      Object.defineProperty(repl.context, key, {
        configurable: true,
        enumerable: true,
        writable: true,
        value,
      })
    }
  }
  assign(initial)

  // 代码修改后应用会热替换：同步更新上下文中的应用、门面与模型
  const unsubscribe = server.onReload(async (result) => {
    if (!result.ok)
      return
    assign(await replContext(server, root, srcDir))
    repl.displayPrompt(true)
  })
  repl.defineCommand('reload', {
    help: '重新加载应用',
    async action() {
      const result = await server.reload()
      if (!result.ok)
        consola.error(result.error)
      this.displayPrompt()
    },
  })
  setupHistory(repl, root)

  await exited
  unsubscribe()
  await server.close()
}

/** 历史记录保存在 .haze/repl_history */
function setupHistory(repl: ReturnType<typeof start>, root: string): void {
  const dir = join(root, '.haze')
  try {
    mkdirSync(dir, { recursive: true })
    repl.setupHistory(join(dir, 'repl_history'), (error) => {
      if (error)
        consola.warn('REPL history is disabled', error)
    })
  }
  catch (error) {
    consola.warn('REPL history is disabled', error)
  }
}

/** 打印：模型记录显示为 `User { id: 1, ... }`（全部字段与已加载的关联），其余交给 util.inspect */
function format(value: unknown, colors: boolean): string {
  return inspect(prettify(value, 0), {
    colors,
    depth: 4,
    breakLength: process.stdout.columns || 80,
  })
}

function prettify(value: unknown, depth: number): unknown {
  if (depth > 4 || value === null || typeof value !== 'object')
    return value
  if (Array.isArray(value))
    return value.map(item => prettify(item, depth + 1))
  if (isRecord(value)) {
    const name = value.constructor.name || 'Record'
    const Named = { [name]: class {} }[name]
    return Object.assign(new Named(), Object.fromEntries(Object.entries({
      ...value.$attributes,
      ...value.$relations,
    }).map(([key, item]) => [
      key,
      prettify(item, depth + 1),
    ])))
  }
  // 分页结果等普通对象
  if (Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key,
      prettify(item, depth + 1),
    ]))
  }
  return value
}

function isRecord(value: object): value is { constructor: { name: string }, $attributes: Record<string, unknown>, $relations?: Record<string, unknown> } {
  return '$attributes' in value && typeof (value as { toJSON?: unknown }).toJSON === 'function'
}

function isClass(value: unknown): value is { name: string } {
  return typeof value === 'function' && Function.prototype.toString.call(value).startsWith('class')
}

function modelFiles(dir: string): string[] {
  if (!existsSync(dir))
    return []
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter(file => SOURCE_RE.test(file) && !file.endsWith('.d.ts'))
    .sort()
    .map(file => join(dir, file))
}
