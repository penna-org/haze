import type { DevServer } from '@hazejs/vite'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

type Core = typeof import('@hazejs/core')

/** 每个开发服务器：应用的依赖是否由 Node 原生加载 */
const nativeDeps = new WeakMap<DevServer, Promise<boolean>>()

function importNative<T>(root: string, id: string): Promise<T> {
  const require = createRequire(join(root, 'package.json'))
  return import(pathToFileURL(require.resolve(id)).href) as Promise<T>
}

/**
 * 应用的依赖是否由 Node 原生加载：`server.import('@hazejs/core')` 没有 importer，Vite 总是把它当作入口在
 * module runner 中内联执行；而应用代码中的 `import '@hazejs/core'` 在依赖被外部化（安装在 node_modules 中，
 * 不是 workspace 链接）时由 Node 原生加载。两份模块实例的类与模块级状态都不相同
 * （`app.make(runnerCore.Scheduler)` 会构造出一个没有应用的新实例），按 `app instanceof Application` 判断
 */
function usesNativeDeps(server: DevServer): Promise<boolean> {
  let result = nativeDeps.get(server)
  if (!result) {
    result = (async () => {
      const app = server.app
      if (!app)
        return false
      const inlined = await server.import<Core>('@hazejs/core')
      return !(app instanceof inlined.Application)
    })()
    nativeDeps.set(server, result)
  }
  return result
}

/**
 * 以应用使用的那份模块实例加载依赖包（`@hazejs/core`、`@hazejs/orm` 等）：
 * 应用的依赖被外部化时从项目根目录按 Node 的规则解析并原生导入，否则在开发服务器的模块图中加载
 */
export async function importFromApp<T = any>(server: DevServer, root: string, id: string): Promise<T> {
  if (!(await usesNativeDeps(server)))
    return server.import<T>(id)
  return importNative<T>(root, id)
}

/** 应用使用的 @hazejs/core（`app.make(core.Scheduler)` 等按类取服务时必须是同一份实例） */
export async function appCore(server: DevServer, root: string): Promise<Core> {
  const core = await importFromApp<Core>(server, root, '@hazejs/core')
  if (server.app && !(server.app instanceof core.Application))
    throw new Error('Cannot load the @hazejs/core instance the application was created with; make sure the project resolves a single copy of @hazejs/core')
  return core
}
