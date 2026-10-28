import type { AlipayProviderConfig } from './providers/alipay'
import type { AppleProviderConfig } from './providers/apple'
import type { FeishuProviderConfig } from './providers/feishu'
import type { GitHubProviderConfig } from './providers/github'
import type { GitLabProviderConfig } from './providers/gitlab'
import type { MicrosoftProviderConfig } from './providers/microsoft'
import type { GoogleProviderConfig, OidcProviderConfig } from './providers/oidc'
import type { QQProviderConfig } from './providers/qq'
import type { WeChatProviderConfig } from './providers/wechat'
import type { WeComProviderConfig } from './providers/wecom'
import type { BaseProviderConfig } from './types'

/** 内置驱动名 → 配置类型 */
export interface BuiltinProviderConfigs {
  github: GitHubProviderConfig
  google: GoogleProviderConfig
  apple: AppleProviderConfig
  microsoft: MicrosoftProviderConfig
  gitlab: GitLabProviderConfig
  discord: BaseProviderConfig
  wechat: WeChatProviderConfig
  wechat_mp: WeChatProviderConfig
  qq: QQProviderConfig
  dingtalk: BaseProviderConfig
  feishu: FeishuProviderConfig
  wecom: WeComProviderConfig
  alipay: AlipayProviderConfig
  oidc: OidcProviderConfig
}

/** 键名为内置驱动名时按该驱动的配置类型检查；其它键名需写 driver */
export type ProviderConfigs = {
  [K in keyof BuiltinProviderConfigs]?: (BuiltinProviderConfigs[K] & { driver?: K }) | false | null
} & {
  [name: string]: (BaseProviderConfig & { [key: string]: any }) | false | null | undefined
}

export interface OAuthConfig {
  /**
   * 第三方登录的提供方。值为 false / null / undefined，或 clientId 为空时视为未启用
   * （`OAuth.enabled(name)` 返回 false，`OAuth.driver(name)` 抛 404），
   * 便于在未配置环境变量时整体关闭某个登录方式。
   */
  providers: ProviderConfigs
  /** state 的保存方式：`cookie`（默认，AES-GCM 加密的短期 Cookie，无需会话）或 `session` */
  stateStore?: 'cookie' | 'session'
  /** state Cookie 名前缀，默认 `haze_oauth`（实际名为 `<前缀>_<驱动名>`） */
  cookie?: string
  /** 授权的有效期（从跳转到回调），默认 `10m` */
  stateTtl?: string | number
  /** 替换 HTTP 客户端（代理、测试中的模拟服务器），默认全局 fetch */
  fetch?: typeof fetch
}

/** `config/oauth.ts` 的默认导出 */
export function defineOAuthConfig(config: OAuthConfig | (() => OAuthConfig)): OAuthConfig | (() => OAuthConfig) {
  return config
}

const UNITS: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 }

/** `'10m'` / `600` → 秒 */
export function parseTtl(value: string | number): number {
  if (typeof value === 'number')
    return value
  const match = /^(\d+)\s*([smhd]?)$/.exec(value.trim())
  if (!match)
    throw new Error(`Invalid duration "${value}" (e.g. 600, '10m', '1h')`)
  return Number(match[1]) * (UNITS[match[2] || 's'])
}
