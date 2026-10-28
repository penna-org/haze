// 虚拟模块类型声明：在 tsconfig 的 types 中加入 "@hazejs/vite/client"

declare module 'virtual:haze/app' {
  import type { Application, ApplicationOptions } from '@hazejs/core'

  /** 使用编译期发现的 config / route / provider / exception 创建应用 */
  export function createApp(options?: ApplicationOptions): Promise<Application>
}

declare module 'virtual:haze/migrations' {
  /** 打包进产物的迁移文件（相对后端源码目录的路径 → 内容），用于 runMigrations({ files }) */
  export const files: Record<string, string>
}
