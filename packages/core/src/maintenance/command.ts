import type { Application } from '../application'
import type { DownOptions, MaintenanceState } from './config'
import process from 'node:process'
import { parseCommandArgs } from '../console/args'
import { MaintenanceManager } from './manager'

/** haze down / worker.mjs down 的参数定义 */
export const downArgs = {
  secret: { type: 'string', description: '绕过密钥：访问 /<secret> 后可正常访问（字母、数字、- 与 _）' },
  withSecret: { type: 'boolean', description: '生成随机的绕过密钥', default: false },
  retry: { type: 'string', description: 'Retry-After 秒数（默认 60）' },
  refresh: { type: 'string', description: 'Refresh 秒数（浏览器自动刷新）' },
  status: { type: 'string', description: '状态码（默认 503）' },
  redirect: { type: 'string', description: 'HTML 请求重定向到的路径，如 /maintenance' },
  render: { type: 'string', description: '渲染的视图（app/view 下的名称，如 Maintenance）' },
  except: { type: 'string', description: '放行的路径，逗号分隔，支持 *（如 /health,/api/webhooks/*）' },
  message: { type: 'string', description: '提示消息（可以是翻译键）' },
} as const

function toNumber(name: string, value: string | undefined): number | undefined {
  if (value === undefined || value === '')
    return undefined
  const number = Number(value)
  if (!Number.isInteger(number) || number < 0)
    throw new Error(`--${name} must be a non-negative integer`)
  return number
}

/** 把命令行参数（字符串）转为 down() 的选项 */
export function toDownOptions(args: Partial<Record<keyof typeof downArgs, string | boolean | undefined>>): DownOptions {
  const status = toNumber('status', args.status as string | undefined)
  if (status !== undefined && (status < 400 || status > 599))
    throw new Error('--status must be a 4xx or 5xx status code')
  return {
    secret: (args.secret as string | undefined) || undefined,
    withSecret: Boolean(args.withSecret),
    retry: toNumber('retry', args.retry as string | undefined),
    refresh: toNumber('refresh', args.refresh as string | undefined),
    status,
    redirect: (args.redirect as string | undefined) || undefined,
    render: (args.render as string | undefined) || undefined,
    except: (args.except as string | undefined)?.split(',').map(item => item.trim()).filter(Boolean),
    message: (args.message as string | undefined) || undefined,
  }
}

/** 维护状态的文字描述（haze maintenance:status） */
export function describeMaintenance(state: MaintenanceState | undefined, location: string): string {
  if (!state)
    return `Application is up (${location})`
  return [
    `Application is down since ${new Date(state.time).toISOString()} (${location})`,
    `  status ${state.status}, Retry-After ${state.retry ?? '-'}${state.refresh
      ? `, Refresh ${state.refresh}`
      : ''}`,
    state.redirect && `  redirect ${state.redirect}`,
    state.render && `  view ${state.render}`,
    state.except?.length && `  except ${state.except.join(', ')}`,
    state.message && `  message ${state.message}`,
    state.secret && '  bypass secret set',
  ].filter(Boolean).join('\n')
}

/**
 * 生产入口的维护命令（`worker.mjs down [...] / up / maintenance:status`），返回退出码。
 * 与 haze down / up / maintenance:status 相同，输出写到 stdout。
 */
export async function runMaintenanceCommand(app: Application, argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv
  const manager = app.make(MaintenanceManager)
  const print = (line: string): void => void process.stdout.write(`${line}\n`)
  const warning = manager.warning()
  if (warning && command !== 'maintenance:status')
    print(`Warning: ${warning}`)
  if (command === 'down') {
    const args = parseCommandArgs(rest, downArgs)
    const { state, secret, driver } = await manager.down(toDownOptions(args))
    print(`Application is now in maintenance mode (${driver.location}, status ${state.status})`)
    if (secret)
      print(`Bypass: visit /${secret}`)
    return 0
  }
  if (command === 'up') {
    const wasDown = await manager.up()
    print(wasDown
      ? 'Application is now live'
      : 'Application was not in maintenance mode')
    return 0
  }
  if (command === 'maintenance:status') {
    print(describeMaintenance(await manager.state({ fresh: true }), manager.driver().location))
    return 0
  }
  print(`Unknown maintenance command "${command}" (down | up | maintenance:status)`)
  return 1
}
