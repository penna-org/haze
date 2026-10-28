import type { createProject as CreateProject } from './utils'
import { join } from 'node:path'
import { buildServer } from '@hazejs/vite'
import { afterEach, describe, expect, it } from 'vitest'
import { binOf, createProject, run } from './utils'

let project: ReturnType<typeof CreateProject> | undefined
afterEach(() => {
  project?.cleanup()
  project = undefined
})

/** 不传 NODE_ENV=test，否则 consola 会隐藏命令的输出 */
function haze(...args: string[]) {
  return run(binOf('@hazejs/cli', 'haze'), [...args, '--root', project!.root], project!.root, {})
}

const sendReport = `import { defineCommand } from '@hazejs/core'

export default defineCommand({
  description: 'Send the daily report',
  args: {
    to: { type: 'positional', description: 'Recipient' },
    format: { type: 'enum', options: ['text', 'json'], default: 'text' },
    dryRun: { type: 'boolean', alias: 'd', description: 'Print only' },
    times: { type: 'string', default: '1' },
  },
  async run(args, ctx) {
    console.log('REPORT', JSON.stringify({ to: args.to, format: args.format, dryRun: args.dryRun, times: args.times, rest: args._.slice(1), app: ctx.app.config.get('app.name'), name: ctx.name }))
    return args.dryRun ? 3 : 0
  },
})
`

describe('console commands', () => {
  it('discovers app/command files, lists them in --help and runs them with parsed args', async () => {
    project = createProject('api')
    project.write('app/command/SendReport.ts', sendReport)
    project.write('app/command/db/PruneOld.ts', `import { defineCommand } from '@hazejs/core'
export default defineCommand({ description: 'Prune old rows', run: () => console.log('PRUNED') })
`)
    project.write('app/command/Renamed.ts', `import { defineCommand } from '@hazejs/core'
export default defineCommand({ name: 'custom:named', description: 'Explicit name', run: () => { throw new Error('boom from command') } })
`)
    // 默认导出不是命令的模块被忽略
    project.write('app/command/helpers.ts', 'export function helper() { return 1 }\n')

    const help = await haze('--help')
    expect(help.code, help.output).toBe(0)
    for (const text of [
      'send:report',
      'Send the daily report',
      'db:prune-old',
      'custom:named',
      'inspire',
      '打印一句名言',
      'make:command',
      'make:mail',
      'repl',
    ])
      expect(help.output, text).toContain(text)
    expect(help.output).not.toContain('helpers')

    const report = await haze('send:report', 'ada@example.com', 'extra', '--format', 'json', '-d')
    expect(report.code, report.output).toBe(3)
    expect(JSON.parse(/REPORT (.+)/.exec(report.output)![1])).toEqual({
      to: 'ada@example.com',
      format: 'json',
      dryRun: true,
      times: '1',
      rest: ['extra'],
      app: 'demo-api',
      name: 'send:report',
    })
    const defaults = await haze('send:report', 'bob', '--times=2', '--no-dry-run')
    expect(defaults.code, defaults.output).toBe(0)
    expect(defaults.output).toContain('"format":"text","dryRun":false,"times":"2"')

    const usage = await haze('send:report', '--help')
    expect(usage.code).toBe(0)
    expect(usage.output).toContain('--dryRun')
    expect(usage.output).toContain('TO')

    const missing = await haze('send:report')
    expect(missing.code).toBe(1)
    expect(missing.output).toContain('Missing required positional argument: TO')
    const invalid = await haze('send:report', 'ada', '--format', 'xml')
    expect(invalid.code).toBe(1)
    expect(invalid.output).toContain('Invalid value')

    const pruned = await haze('db:prune-old')
    expect([pruned.code, pruned.output]).toEqual([
      0,
      expect.stringContaining('PRUNED'),
    ])
    const failed = await haze('custom:named')
    expect(failed.code).toBe(1)
    expect(failed.output).toContain('boom from command')
    const inspire = await haze('inspire', '--all')
    expect(inspire.code, inspire.output).toBe(0)
    expect(inspire.output).toContain('千里之行，始于足下')

    const unknown = await haze('nope')
    expect(unknown.code).toBe(1)
    expect(unknown.output).toContain('Unknown command')

    // 生产产物：worker.mjs command 使用同样的发现与参数解析
    await buildServer({ root: project.root })
    const worker = (...args: string[]) => run(join(project!.root, 'dist/worker.mjs'), ['command', ...args], project!.root, { NODE_ENV: 'production' })
    const list = await worker()
    expect(list.code, list.output).toBe(0)
    for (const name of [
      'send:report',
      'db:prune-old',
      'custom:named',
      'inspire',
    ])
      expect(list.output).toContain(name)
    const production = await worker('send:report', 'ada', '--format=json', '--dry-run')
    expect(production.code, production.output).toBe(3)
    expect(production.output).toContain('"to":"ada","format":"json","dryRun":true')
    expect((await worker('send:report', '--help')).output).toContain('--dry-run')
    expect((await worker('send:report')).code).toBe(1)
    expect((await worker('custom:named')).code).toBe(1)
    expect((await worker('inspire', '-a')).output).toContain('Knowledge is power.')
    const missingCommand = await worker('nope')
    expect([missingCommand.code, missingCommand.output]).toEqual([
      1,
      expect.stringContaining('Unknown command nope'),
    ])
  })

  it('discovers commands under srcDir in full-stack projects', async () => {
    project = createProject('vue')
    const inspire = await haze('inspire', '--all')
    expect(inspire.code, inspire.output).toBe(0)
    expect(inspire.output).toContain('Well begun is half done.')
  })

  it('make:command and make:mail output typechecks and runs', async () => {
    project = createProject('api')
    for (const args of [
      ['make:command', 'SendReport'],
      ['make:command', 'db/PruneOld'],
      ['make:mail', 'Invoice'],
    ]) {
      const result = await haze(...args)
      expect(result.code, result.output).toBe(0)
    }
    expect(project.read('app/mail/InvoiceMail.ts')).toContain(`{ name: 'InvoiceMail' }`)
    // 参数类型推导：必填位置参数为 string，未给默认值的 string 可能为 undefined，枚举为字面量联合
    project.write('probe.ts', `import { defineCommand, Mail } from '@hazejs/core'
import InvoiceMail from '~/app/mail/InvoiceMail'
export default defineCommand({
  args: {
    to: { type: 'positional' },
    optional: { type: 'positional', required: false },
    count: { type: 'string' },
    level: { type: 'string', default: 'info' },
    force: { type: 'boolean' },
    mode: { type: 'enum', options: ['a', 'b'] },
  },
  async run(args, ctx) {
    const to: string = args.to
    // @ts-expect-error 可选位置参数可能为 undefined
    const optional: string = args.optional
    // @ts-expect-error 没有默认值的字符串参数可能为 undefined
    const count: string = args.count
    const level: string = args.level
    const force: boolean = args.force
    const mode: 'a' | 'b' | undefined = args.mode
    // @ts-expect-error 枚举之外的值
    const wrong: 'c' | undefined = args.mode
    await Mail.to(to).send(InvoiceMail, { name: 'Ada' })
    ctx.logger.info(String([optional, count, level, force, mode, wrong]))
    return await ctx.confirm('ok?') ? 0 : 1
  },
})
`)
    const tsc = await run(binOf('typescript', 'tsc'), ['--noEmit', '-p', 'tsconfig.json'], project.root)
    expect(tsc.output).toBe('')

    const report = await haze('send:report', 'ada', '--dry-run')
    expect(report.code, report.output).toBe(0)
    expect(report.output).toContain('send:report: ada (dry run)')
    const prune = await haze('db:prune-old')
    expect(prune.code, prune.output).toBe(0)
    expect(prune.output).toContain('db:prune-old: all')
  })
})

describe('haze repl', () => {
  it('evaluates code with the app, facades and models in context', async () => {
    project = createProject('api')
    expect((await haze('db:migrate')).code).toBe(0)

    const count = await haze('repl', '--eval', 'await User.count()')
    expect(count.code, count.output).toBe(0)
    expect(count.output.trim().split('\n').at(-1)).toBe('0')

    const globals = await haze('repl', '-e', '[app, Cache, Queue, Events, Storage, Mail, Db, inject, User].every(value => value !== undefined) && typeof Cache.get === "function" && config("app.name")')
    expect(globals.code, globals.output).toBe(0)
    expect(globals.output).toContain(`'demo-api'`)

    // 多条语句：按函数体执行，return 的值被打印；模型记录打印为字段
    const created = await haze('repl', '-e', `const user = await User.create({ name: 'Ada', email: 'ada@example.com', password: 'x' })
return await User.findOrFail(user.id)`)
    expect(created.code, created.output).toBe(0)
    expect(created.output).toMatch(/User \{[^}]*name: 'Ada'/)

    const failed = await haze('repl', '-e', 'throw new Error("repl boom")')
    expect(failed.code).toBe(1)
    expect(failed.output).toContain('repl boom')
  })
})
