import type { BuiltinProviderConfigs, OAuthConfig } from './config'
import type { OAuthProvider } from './provider'
import type { BaseProviderConfig, DriverOptions, OAuthDriverFactory } from './types'
import { NotFoundException, config as readConfig } from '@hazejs/core'
import { parseTtl } from './config'
import { AlipayProvider } from './providers/alipay'
import { AppleProvider } from './providers/apple'
import { DingTalkProvider } from './providers/dingtalk'
import { DiscordProvider } from './providers/discord'
import { FeishuProvider } from './providers/feishu'
import { GitHubProvider } from './providers/github'
import { GitLabProvider } from './providers/gitlab'
import { MicrosoftProvider } from './providers/microsoft'
import { GoogleProvider, OidcProvider } from './providers/oidc'
import { QQProvider } from './providers/qq'
import { WeChatMpProvider, WeChatProvider } from './providers/wechat'
import { WeComProvider } from './providers/wecom'

type ProviderClass = new (name: string, config: any, options: DriverOptions) => OAuthProvider

function factoryOf(Provider: ProviderClass): OAuthDriverFactory {
  return (name, config, options) => new Provider(name, config, options)
}

const drivers = new Map<string, OAuthDriverFactory>(Object.entries({
  github: factoryOf(GitHubProvider),
  google: factoryOf(GoogleProvider),
  apple: factoryOf(AppleProvider),
  microsoft: factoryOf(MicrosoftProvider),
  gitlab: factoryOf(GitLabProvider),
  discord: factoryOf(DiscordProvider),
  wechat: factoryOf(WeChatProvider),
  wechat_mp: factoryOf(WeChatMpProvider),
  qq: factoryOf(QQProvider),
  dingtalk: factoryOf(DingTalkProvider),
  feishu: factoryOf(FeishuProvider),
  wecom: factoryOf(WeComProvider),
  alipay: factoryOf(AlipayProvider),
  oidc: factoryOf(OidcProvider),
}))

/**
 * 注册自定义驱动（在服务提供者的 register / boot 中调用），之后可在 config/oauth.ts 中以 `driver: '<name>'` 使用。
 * 可传入 OAuthProvider 子类或 defineOAuthProvider() 的结果；同名覆盖内置驱动。
 */
export function registerOAuthProvider(name: string, driver: OAuthDriverFactory | ProviderClass): void {
  drivers.set(name, isClass(driver)
    ? factoryOf(driver)
    : driver)
}

function isClass(value: OAuthDriverFactory | ProviderClass): value is ProviderClass {
  return typeof value === 'function' && /^class[\s{]/.test(Function.prototype.toString.call(value))
}

/** 已注册的驱动名 */
export function oauthDrivers(): string[] {
  return [
    ...drivers.keys(),
  ]
}

function loadConfig(): OAuthConfig {
  const input = readConfig<OAuthConfig | (() => OAuthConfig) | undefined>('oauth', undefined)
  const config = typeof input === 'function'
    ? input()
    : input
  if (!config?.providers)
    throw new Error('OAuth is not configured: create config/oauth.ts with defineOAuthConfig()')
  return config
}

function driverOptions(config: OAuthConfig): DriverOptions {
  return {
    fetch: config.fetch ?? ((...args) => globalThis.fetch(...args)),
    stateStore: config.stateStore ?? 'cookie',
    cookie: config.cookie ?? 'haze_oauth',
    stateTtl: parseTtl(config.stateTtl ?? '10m'),
  }
}

function providerConfig(config: OAuthConfig, name: string): BaseProviderConfig | undefined {
  const value = config.providers[name]
  return value && value.clientId
    ? value
    : undefined
}

function create(name: string, providerConfig: BaseProviderConfig, options: DriverOptions): OAuthProvider {
  const driver = providerConfig.driver ?? name
  const factory = typeof driver === 'function'
    ? driver
    : drivers.get(driver)
  if (!factory)
    throw new Error(`Unknown OAuth driver "${String(driver)}" (provider "${name}"). Register it with registerOAuthProvider()`)
  return factory(name, providerConfig, options)
}

type DriverOf<N> = N extends 'github' ? GitHubProvider
  : N extends 'google' ? GoogleProvider
    : N extends 'apple' ? AppleProvider
      : N extends 'microsoft' ? MicrosoftProvider
        : N extends 'gitlab' ? GitLabProvider
          : N extends 'wechat' ? WeChatProvider
            : N extends 'wechat_mp' ? WeChatMpProvider
              : N extends 'qq' ? QQProvider
                : N extends 'dingtalk' ? DingTalkProvider
                  : N extends 'feishu' ? FeishuProvider
                    : N extends 'wecom' ? WeComProvider
                      : N extends 'alipay' ? AlipayProvider
                        : N extends 'oidc' ? OidcProvider
                          : OAuthProvider

/**
 * 第三方登录门面：
 *
 * ```ts
 * // 跳转授权
 * return OAuth.driver('github').redirect(ctx)
 * // 回调：校验 state、换取令牌、读取用户
 * const user = await OAuth.driver('github').user(ctx)
 * ```
 *
 * 配置来自 config/oauth.ts（请求内为当前应用的配置）。每次调用 driver() 返回新的实例。
 */
export const OAuth = {
  /** 取配置中的提供方；未配置或未启用时抛 404（便于 `/auth/:provider` 这类动态路由） */
  driver<N extends string>(name: N): DriverOf<N> {
    const config = loadConfig()
    const provider = providerConfig(config, name)
    if (!provider)
      throw new NotFoundException(`OAuth provider "${name}" is not enabled`)
    return create(name, provider, driverOptions(config)) as DriverOf<N>
  },

  /** 不经过 config/oauth.ts，直接用给定配置构造（多租户、动态 client 等） */
  build<D extends keyof BuiltinProviderConfigs>(driver: D | OAuthDriverFactory, config: BuiltinProviderConfigs[D] | BaseProviderConfig, options: Partial<OAuthConfig> = {}): DriverOf<D> {
    const name = typeof driver === 'string'
      ? driver
      : 'custom'
    return create(name, { ...config, driver }, driverOptions({ providers: {}, ...options })) as DriverOf<D>
  },

  /** 该提供方是否已配置并启用（clientId 非空） */
  enabled(name: string): boolean {
    const input = readConfig<OAuthConfig | (() => OAuthConfig) | undefined>('oauth', undefined)
    const config = typeof input === 'function'
      ? input()
      : input
    return Boolean(config?.providers && providerConfig(config, name))
  },

  /** 已启用的提供方名（用于渲染登录按钮） */
  providers(): string[] {
    const input = readConfig<OAuthConfig | (() => OAuthConfig) | undefined>('oauth', undefined)
    const config = typeof input === 'function'
      ? input()
      : input
    return config?.providers
      ? Object.keys(config.providers).filter(name => providerConfig(config, name))
      : []
  },
}
