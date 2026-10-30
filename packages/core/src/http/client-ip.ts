/**
 * 客户端 IP 的解析。
 *
 * 平台适配器（Cloudflare Workers 的 `cf-connecting-ip`、AWS Lambda 事件的 `sourceIp`、srvx 的 Node / Bun / Deno 服务器）
 * 把它得知的客户端地址放在 `request.ip`（srvx 的 ServerRequest 约定）；位于反向代理之后时再按 `app.trustProxy`
 * 从 `X-Forwarded-For` 中取出真实客户端。
 */

/** `config/app.ts` 的 `trustProxy`：`true` 为 1 层可信代理，数字为可信代理的层数 */
export type TrustProxy = boolean | number

/** 平台适配器补充了客户端地址的请求（srvx 的 ServerRequest 也符合此形状） */
export interface RequestWithAddress extends Request {
  ip?: string
  context?: { clientAddress?: string }
}

/** 可信代理层数：`true` → 1，正整数原样，其余 0 */
export function trustedProxyHops(trust: unknown): number {
  if (trust === true)
    return 1
  if (typeof trust === 'number' && Number.isInteger(trust) && trust > 0)
    return trust
  return 0
}

/**
 * 记录平台得知的客户端地址，供 `ctx.ip` 读取（`trustProxy` 关闭时直接使用；开启时作为没有 X-Forwarded-For 的回退）。
 * 自定义部署入口可用它把平台提供的地址传给应用：
 *
 * ```ts
 * app.fetch(setClientAddress(request, request.headers.get('cf-connecting-ip')))
 * ```
 */
export function setClientAddress<T extends Request>(request: T, ip: string | null | undefined): T {
  if (ip) {
    Object.defineProperty(request, 'ip', {
      value: ip,
      configurable: true,
      enumerable: false,
      writable: true,
    })
  }
  return request
}

/**
 * 客户端 IP。`trustProxy` 开启时取 `X-Forwarded-For` 从右数第 n 项（n 为可信代理层数）：最右一项是最近的
 * 可信代理追加的，再往左都是客户端自己可以伪造的；关闭时只用平台给出的连接地址。
 */
export function clientIp(request: RequestWithAddress, trust: TrustProxy | undefined): string | undefined {
  const hops = trustedProxyHops(trust)
  if (hops > 0) {
    const header = request.headers.get('x-forwarded-for')
    if (header) {
      const entries = header.split(',').map(entry => entry.trim()).filter(Boolean)
      if (entries.length)
        return entries[Math.max(0, entries.length - hops)]
    }
  }
  return request.context?.clientAddress || request.ip || undefined
}
