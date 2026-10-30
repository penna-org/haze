import type { TemplateName } from './scaffold'
import { relative } from 'node:path'
import process from 'node:process'
import { defineCommand, runMain } from 'citty'
import { consola } from 'consola'
import { colors } from 'consola/utils'
import { scaffold, TEMPLATES } from './scaffold'

const main = defineCommand({
  meta: {
    name: 'create-hazejs',
    description: '创建 hazejs 项目',
  },
  args: {
    dir: { type: 'positional', description: '项目目录', required: false },
    template: { type: 'string', alias: 't', description: `模板：${Object.keys(TEMPLATES).join(' | ')}` },
    force: { type: 'boolean', description: '目标目录非空时覆盖', default: false },
    autoImport: { type: 'boolean', description: '开启自动导入（控制器、服务、框架 API 等无需手写 import）' },
  },
  async run({ args }) {
    const interactive = process.stdin.isTTY && !process.env.CI

    let dir = args.dir
    if (!dir && interactive)
      dir = await consola.prompt('项目名称', { type: 'text', placeholder: 'my-app', cancel: 'reject' })
    if (!dir)
      throw new Error('请指定项目目录，例如：create-hazejs my-app')

    let template = args.template as TemplateName | undefined
    if (!template && interactive) {
      template = await consola.prompt('选择模板', {
        type: 'select',
        options: Object.entries(TEMPLATES).map(([value, hint]) => ({ value, label: value, hint })),
        cancel: 'reject',
      }) as unknown as TemplateName
    }
    template ??= 'api'

    // 模块包由其它项目使用，不开启自动导入
    let autoImport = template === 'module'
      ? false
      : args.autoImport as boolean | undefined
    if (autoImport === undefined && interactive) {
      autoImport = await consola.prompt('开启自动导入？（控制器、服务、框架 API 等无需手写 import）', {
        type: 'confirm',
        initial: false,
        cancel: 'reject',
      })
    }

    const result = scaffold({
      dir,
      template,
      force: args.force,
      autoImport,
    })
    const pm = detectPackageManager()
    const cd = relative(process.cwd(), result.root) || '.'

    consola.success(`已创建 ${colors.cyan(result.name)}（${template} 模板，${result.files.length} 个文件）`)
    consola.log(`
  下一步：

    ${cd === '.'
      ? ''
      : `cd ${cd}\n    `}${pm} install
    ${pm === 'npm'
      ? 'npm run'
      : pm} dev
`)
  },
})

function detectPackageManager(): string {
  const agent = process.env.npm_config_user_agent ?? ''
  if (agent.startsWith('pnpm'))
    return 'pnpm'
  if (agent.startsWith('yarn'))
    return 'yarn'
  if (agent.startsWith('bun'))
    return 'bun'
  return 'npm'
}

runMain(main)
