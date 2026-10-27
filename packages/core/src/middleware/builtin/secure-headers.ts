import type { MiddlewareHandler } from '../types'
import { getRequestProtocol } from 'h3'

/** 每项设为 false 关闭，字符串覆盖默认值 */
export interface SecureHeadersOptions {
  /** 默认关闭（单页应用的内联脚本 / 第三方资源容易被拦截），按需配置 */
  contentSecurityPolicy?: string | false
  /** 默认 `max-age=15552000; includeSubDomains`，只在生产环境的 https 请求上发送 */
  strictTransportSecurity?: string | false
  /** 默认 `SAMEORIGIN` */
  frameOptions?: 'DENY' | 'SAMEORIGIN' | false
  /** 默认 `no-referrer` */
  referrerPolicy?: string | false
  /** 默认 `same-origin` */
  crossOriginOpenerPolicy?: string | false
  /** 默认 `same-origin`（只影响 img / script 等无 CORS 的跨源加载） */
  crossOriginResourcePolicy?: string | false
  /** 默认不发送 */
  permissionsPolicy?: string | false
  /** 额外的响应头 */
  headers?: Record<string, string>
}

export function defineSecureHeadersConfig(config: SecureHeadersOptions | (() => SecureHeadersOptions)): SecureHeadersOptions | (() => SecureHeadersOptions) {
  return config
}

/** `secureHeaders`：常用安全响应头（参考 helmet 的默认值，配置在 config/secureHeaders.ts） */
export const secureHeaders: MiddlewareHandler = (ctx, next) => {
  const options = ctx.config.get<SecureHeadersOptions>('secureHeaders', {})
  const headers: Record<string, string | false | undefined> = {
    'x-content-type-options': 'nosniff',
    'x-dns-prefetch-control': 'off',
    'x-download-options': 'noopen',
    'x-permitted-cross-domain-policies': 'none',
    'x-xss-protection': '0',
    'origin-agent-cluster': '?1',
    'x-frame-options': options.frameOptions ?? 'SAMEORIGIN',
    'referrer-policy': options.referrerPolicy ?? 'no-referrer',
    'cross-origin-opener-policy': options.crossOriginOpenerPolicy ?? 'same-origin',
    'cross-origin-resource-policy': options.crossOriginResourcePolicy ?? 'same-origin',
    'content-security-policy': options.contentSecurityPolicy ?? false,
    'permissions-policy': options.permissionsPolicy ?? false,
  }
  const https = getRequestProtocol(ctx.event, {
    xForwardedProto: ctx.config.get<boolean>('app.trustProxy', false),
  }) === 'https'
  // 开发（debug）时不发送 HSTS，避免浏览器把本地域名长期锁定为 https
  if (https && !ctx.config.get<boolean>('app.debug', false))
    headers['strict-transport-security'] = options.strictTransportSecurity ?? 'max-age=15552000; includeSubDomains'
  for (const [name, value] of Object.entries({
    ...headers,
    ...options.headers,
  })) {
    if (value)
      ctx.setHeader(name, value)
  }
  return next()
}
