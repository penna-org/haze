/**
 * 运行平台注入的绑定（Cloudflare Workers 的 `env`：D1、KV、R2、Secret 等）。
 * 由部署入口在处理请求前设置；数据库驱动等按名称取用。
 */
let bindings: Record<string, unknown> = {}

export function setPlatformBindings(value: Record<string, unknown> | undefined): void {
  bindings = value ?? {}
}

export function usePlatformBinding<T = unknown>(name: string): T | undefined {
  return bindings[name] as T | undefined
}
