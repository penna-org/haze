// 虚拟模块类型声明：在 tsconfig 的 types 中加入 "@think-h3/vite/client"

declare module 'virtual:think/app' {
  import type { Application, ApplicationOptions } from '@think-h3/core'

  /** 使用编译期发现的 config / route / provider / exception 创建应用 */
  export function createApp(options?: ApplicationOptions): Promise<Application>
}
