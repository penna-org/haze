import process from 'node:process'
import { createDevServer } from '@hazejs/vite'
import { defineCommand } from 'citty'
import { consola } from 'consola'
import { resolveRoot, rootArg } from '../args'

type Microservices = typeof import('@hazejs/microservices')

/** `haze microservice:listen`：在开发服务器的模块图中启动应用并监听微服务消息（不监听 HTTP 端口） */
export default defineCommand({
  meta: {
    name: 'microservice:listen',
    description: '监听微服务消息（config/microservices.ts，处理器代码修改后自动生效）',
  },
  args: {
    ...rootArg,
    transport: {
      type: 'string',
      alias: 't',
      description: '要监听的传输，逗号分隔（默认 config/microservices.ts 的 listen 或 default）',
    },
  },
  async run({ args }) {
    const server = await createDevServer({
      root: resolveRoot(args.root),
      listen: false,
    })
    if (!server.app) {
      await server.close()
      throw new Error('Application failed to start')
    }
    // 从应用的模块图中加载，与应用使用同一个 @hazejs/core 实例
    let microservices: Microservices
    try {
      microservices = await server.import<Microservices>('@hazejs/microservices')
    }
    catch {
      await server.close()
      consola.error('@hazejs/microservices is not installed. Run `pnpm add @hazejs/microservices` first.')
      process.exitCode = 1
      return
    }
    const transports = args.transport?.split(',').map(name => name.trim()).filter(Boolean)
    let listener: Awaited<ReturnType<Microservices['listenMicroservices']>>
    try {
      listener = await microservices.listenMicroservices(server.app, {
        transports,
        // 每条消息使用热替换后的最新应用
        resolve: () => server.app,
      })
    }
    catch (error) {
      await server.close()
      consola.error((error as Error).message)
      process.exitCode = 1
      return
    }
    server.app.logger.info(`Listening for ${listener.patterns.length} message pattern(s) on ${listener.transports.join(', ')}`)
    await new Promise<void>((done) => {
      const stop = async (): Promise<void> => {
        await listener.close()
        await server.close()
        done()
      }
      process.once('SIGINT', stop)
      process.once('SIGTERM', stop)
    })
  },
})
