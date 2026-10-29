import type { DevServer } from '@hazejs/vite'
import { createDevServer } from '@hazejs/vite'
import { defineCommand } from 'citty'
import { consola } from 'consola'
import { colors } from 'consola/utils'
import { resolveRoot, rootArg } from '../args'

type Core = typeof import('@hazejs/core')
type Manager = InstanceType<Core['MaintenanceManager']>

/** 在应用的模块图中取维护模式管理器（与开发服务器读取同一份配置与存储） */
async function withMaintenance<T>(root: string, run: (manager: Manager, core: Core) => Promise<T>): Promise<T> {
  const server: DevServer = await createDevServer({ root, listen: false })
  try {
    if (!server.app)
      throw new Error('Application failed to start')
    const core = await server.import<Core>('@hazejs/core')
    return await run(server.app.make(core.MaintenanceManager), core)
  }
  finally {
    await server.close()
  }
}

export const downCommand = defineCommand({
  meta: { name: 'down', description: '进入维护模式（运行中的开发服务器与 worker 无需重启即生效）' },
  args: {
    ...rootArg,
    'secret': { type: 'string', description: '绕过密钥：访问 /<secret> 后可正常访问' },
    'with-secret': { type: 'boolean', description: '生成随机的绕过密钥', default: false },
    'retry': { type: 'string', description: 'Retry-After 秒数（默认 60）' },
    'refresh': { type: 'string', description: 'Refresh 秒数（浏览器自动刷新）' },
    'status': { type: 'string', description: '状态码（默认 503）' },
    'redirect': { type: 'string', description: 'HTML 请求重定向到的路径，如 /maintenance' },
    'render': { type: 'string', description: '渲染的视图（app/view 下的名称，如 Maintenance）' },
    'except': { type: 'string', description: '放行的路径，逗号分隔，支持 *（如 /api/webhooks/*）' },
    'message': { type: 'string', description: '提示消息（可以是翻译键）' },
  },
  async run({ args }) {
    await withMaintenance(resolveRoot(args.root), async (manager, core) => {
      const options = core.toDownOptions({ ...args, withSecret: args['with-secret'] })
      if (options.render && !core.hasView(manager.app, options.render))
        consola.warn(`View "${options.render}" not found (app/view/${options.render}.tsx), the built-in page will be used`)
      const warning = manager.warning()
      if (warning)
        consola.warn(warning)
      const { state, secret, driver } = await manager.down(options)
      consola.success(`Application is now in maintenance mode ${colors.dim(`(${driver.location}, status ${state.status})`)}`)
      if (secret)
        consola.info(`Bypass: visit ${colors.cyan(`/${secret}`)} to set the bypass cookie`)
      consola.info(`Running servers pick it up within ${manager.config.interval}ms; run ${colors.cyan('haze up')} to go live`)
    })
  },
})

export const upCommand = defineCommand({
  meta: { name: 'up', description: '退出维护模式' },
  args: rootArg,
  async run({ args }) {
    await withMaintenance(resolveRoot(args.root), async (manager) => {
      if (await manager.up())
        consola.success('Application is now live')
      else
        consola.info('Application was not in maintenance mode')
    })
  },
})

export const maintenanceStatusCommand = defineCommand({
  meta: { name: 'maintenance:status', description: '查看维护模式的状态' },
  args: rootArg,
  async run({ args }) {
    await withMaintenance(resolveRoot(args.root), async (manager, core) => {
      console.log(core.describeMaintenance(await manager.state({ fresh: true }), manager.driver().location))
      const warning = manager.warning()
      if (warning)
        consola.warn(warning)
    })
  },
})
