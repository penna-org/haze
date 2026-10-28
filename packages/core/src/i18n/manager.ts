import type { Config } from '../config/config'
import type { HttpContext } from '../http/context'
import type { ModuleRecord } from '../utils'
import type { I18nConfig, LocaleDetector } from './config'
import type { FrameworkMessages } from './messages'
import { AsyncLocalStorage } from 'node:async_hooks'
import { getRequestStore } from '../request'
import { deepMerge, isPlainObject, unwrapDefault } from '../utils'
import { defaultI18nConfig } from './config'
import { frameworkMessages } from './messages'

/** 翻译参数：`{name}` 占位符的值；`count` 同时用于选择复数形式 */
export type TranslationParams = Record<string, unknown> & { count?: number }

/** 翻译条目：字符串、复数形式对象（`{ one, other }`）、函数，或嵌套的命名空间 */
export interface Messages {
  [key: string]: string | ((params: TranslationParams) => string) | Messages
}

/**
 * lang/ 下的翻译文件，由 `haze typegen`（开发服务器自动执行）生成：
 * `messages: typeof import('../../lang/en/messages').default`
 */
export interface GeneratedTranslations {}

type PluralCategory = 'zero' | 'one' | 'two' | 'few' | 'many' | 'other'

type IsPlural<T> = T extends (...args: any[]) => any
  ? false
  : T extends object
    ? [Exclude<keyof T, PluralCategory>] extends [never]
        ? 'other' extends keyof T ? true : false
        : false
    : false

/** 翻译键：嵌套对象展开为 `file.path.to.key`，复数形式对象视为一个键 */
export type TranslationPath<T, P extends string = ''> = {
  [K in keyof T & (string | number)]: T[K] extends string | ((...args: any[]) => any)
    ? `${P}${K}`
    : IsPlural<T[K]> extends true
      ? `${P}${K}`
      : T[K] extends object
        ? TranslationPath<T[K], `${P}${K}.`>
        : `${P}${K}`
}[keyof T & (string | number)]

/** 生成过翻译类型后只接受已知的键（含框架内置的 validation.* / http.*），否则为 string */
export type TranslationKey = [keyof GeneratedTranslations] extends [never]
  ? string
  : TranslationPath<GeneratedTranslations & FrameworkMessages>

/**
 * 翻译来源：
 * - `import.meta.glob('/lang/*\/**\/*.{ts,json}', { eager: true })`：键为 `/lang/<locale>/<file>.ts`，子目录展开为嵌套键
 * - 直接传对象：`{ 'zh-CN': { messages: { welcome: '欢迎' } } }`
 */
export type LangInput = ModuleRecord | Record<string, Record<string, unknown>>

const LANG_PATH_RE = /(?:^|\/)lang\/([^/]+)\/(.+)\.(?:[cm]?[jt]s|json)$/
const PLACEHOLDER_RE = /\{(\w+)\}/g
const PLURAL_KEYS = new Set<string>([
  'zero',
  'one',
  'two',
  'few',
  'many',
  'other',
])

/** withLocale() 临时切换的语言 */
const scope = new AsyncLocalStorage<string>()
/** 请求内已确定的语言（检测结果或 setLocale） */
const requestLocales = new WeakMap<HttpContext, string>()

type ResolvedI18nConfig = Omit<Required<I18nConfig>, 'locales'> & Pick<I18nConfig, 'locales'>

/**
 * 多语言（应用单例，`inject(I18nManager)`）。翻译文件放在 `lang/<locale>/*.ts`，默认导出嵌套对象：
 * `lang/zh-CN/messages.ts` 中的 `{ welcome: '欢迎，{name}' }` → `t('messages.welcome', { name })`。
 *
 * 只有存在 `config/i18n.ts` 时才会翻译校验错误与框架异常消息；`t()` 始终可用。
 */
export class I18nManager {
  readonly config: ResolvedI18nConfig
  /** 是否配置了 config/i18n.ts（决定是否翻译校验错误与框架异常） */
  readonly enabled: boolean
  readonly #user = new Map<string, Messages>()
  readonly #resolved = new Map<string, Messages>()
  readonly #plurals = new Map<string, Intl.PluralRules>()
  /** 请求之外 setLocale() 设置的语言 */
  #locale: string | undefined

  constructor(config?: Config, lang?: LangInput) {
    const options = config?.get<Partial<I18nConfig> | undefined>('i18n', undefined)
    this.enabled = options !== undefined
    const defaultLocale = options?.defaultLocale ?? defaultI18nConfig.defaultLocale
    this.config = {
      ...defaultI18nConfig,
      ...options,
      defaultLocale,
      fallbackLocale: options?.fallbackLocale ?? defaultLocale,
      detect: options?.detect ?? defaultI18nConfig.detect,
    }
    for (const [locale, messages] of parseLang(lang))
      this.load(locale, messages)
  }

  /** 加载（合并）某个语言的翻译，扩展包也可在提供者中调用 */
  load(locale: string, messages: Record<string, unknown>): this {
    this.#user.set(locale, deepMerge(this.#user.get(locale) ?? {}, messages) as Messages)
    this.#resolved.clear()
    return this
  }

  /** 支持的语言：config.locales，或 lang/ 下的语言加上默认语言 */
  locales(): string[] {
    return this.config.locales ?? [
      ...new Set([
        this.config.defaultLocale,
        ...this.#user.keys(),
      ]),
    ]
  }

  /** 当前语言：withLocale() > 请求语言 > 请求之外 setLocale() 的语言 > 默认语言 */
  get locale(): string {
    const scoped = scope.getStore()
    if (scoped)
      return scoped
    const ctx = getRequestStore()?.ctx
    if (ctx)
      return this.requestLocale(ctx)
    return this.#locale ?? this.config.defaultLocale
  }

  /** 设置当前语言：请求内只影响本次请求，请求之外影响后续的翻译（建议用 withLocale） */
  setLocale(locale: string): void {
    const ctx = getRequestStore()?.ctx
    if (ctx)
      requestLocales.set(ctx, locale)
    else
      this.#locale = locale
  }

  /** 在指定语言下执行函数（异步调用链内有效），如发送邮件、队列任务 */
  withLocale<T>(locale: string, fn: () => T): T {
    return scope.run(locale, fn)
  }

  /** 请求的语言：首次读取时按 config.detect 检测并缓存 */
  requestLocale(ctx: HttpContext): string {
    let locale = requestLocales.get(ctx)
    if (!locale) {
      locale = this.detect(ctx) ?? this.config.defaultLocale
      requestLocales.set(ctx, locale)
    }
    return locale
  }

  /** 按 detect 顺序检测请求语言，没有匹配时返回 undefined */
  detect(ctx: HttpContext): string | undefined {
    for (const detector of this.config.detect) {
      const locale = this.#detectWith(detector, ctx)
      if (locale)
        return locale
    }
    return undefined
  }

  #detectWith(detector: LocaleDetector, ctx: HttpContext): string | undefined {
    if (detector === 'header')
      return this.negotiate(ctx.header('accept-language'))
    const index = detector.indexOf(':')
    const source = detector.slice(0, index)
    const name = detector.slice(index + 1)
    const value = source === 'query'
      ? ctx.query(name)
      : source === 'cookie'
        ? ctx.cookie(name)
        : ctx.header(name)
    return value
      ? this.match(value)
      : undefined
  }

  /** Accept-Language 协商：按 q 值从高到低，返回第一个支持的语言 */
  negotiate(header: string | undefined | null): string | undefined {
    if (!header)
      return undefined
    const candidates = header.split(',')
      .map((part, index) => {
        const [tag, ...params] = part.trim().split(';')
        const q = params.map(param => /^\s*q=([\d.]+)\s*$/.exec(param)?.[1]).find(Boolean)
        return {
          tag: tag.trim(),
          q: q === undefined
            ? 1
            : Number(q),
          index,
        }
      })
      .filter(item => item.tag && item.tag !== '*' && item.q > 0)
      .sort((a, b) => b.q - a.q || a.index - b.index)
    for (const { tag } of candidates) {
      const locale = this.match(tag)
      if (locale)
        return locale
    }
    return undefined
  }

  /** 匹配支持的语言：先精确匹配（不区分大小写），再按语言部分匹配（`zh` / `zh-TW` → `zh-CN`） */
  match(locale: string): string | undefined {
    const wanted = locale.trim().replace(/_/g, '-').toLowerCase()
    if (!wanted)
      return undefined
    const supported = this.locales()
    return supported.find(item => item.toLowerCase() === wanted)
      ?? supported.find(item => language(item) === language(wanted))
  }

  /** 翻译；找不到时依次回退到语言部分（zh-CN → zh）与 fallbackLocale，仍找不到返回键本身 */
  translate(key: string, params: TranslationParams = {}, locale: string = this.locale): string {
    for (const candidate of this.#chain(locale)) {
      const value = lookup(this.#messagesOf(candidate), key)
      if (value !== undefined)
        return this.#render(value, params, candidate)
    }
    return interpolate(key, params)
  }

  /** 是否存在该翻译（含回退语言） */
  has(key: string, locale: string = this.locale): boolean {
    return this.#chain(locale).some(candidate => lookup(this.#messagesOf(candidate), key) !== undefined)
  }

  #chain(locale: string): string[] {
    const { fallbackLocale } = this.config
    return [
      ...new Set([
        locale,
        language(locale),
        fallbackLocale,
        language(fallbackLocale),
      ]),
    ]
  }

  /** 某语言的完整翻译：框架内置（按语言匹配）+ 项目的 lang/<locale> */
  #messagesOf(locale: string): Messages | undefined {
    let messages = this.#resolved.get(locale)
    if (!messages) {
      const builtin = frameworkMessages[locale]
        ?? Object.entries(frameworkMessages).find(([name]) => language(name) === language(locale))?.[1]
      const user = this.#user.get(locale)
      if (!builtin && !user)
        return undefined
      messages = deepMerge((builtin ?? {}) as Messages, user ?? {})
      this.#resolved.set(locale, messages)
    }
    return messages
  }

  #render(value: Leaf, params: TranslationParams, locale: string): string {
    if (typeof value === 'function')
      return value(params)
    if (typeof value === 'string')
      return interpolate(value, params)
    return interpolate(this.#plural(value, params.count, locale), params)
  }

  /** 复数：count 为 0 且提供了 zero 时用 zero，否则按 Intl.PluralRules 选择，缺省用 other */
  #plural(forms: Record<string, string>, count: number | undefined, locale: string): string {
    if (count === undefined)
      return forms.other
    if (count === 0 && forms.zero !== undefined)
      return forms.zero
    let rules = this.#plurals.get(locale)
    if (!rules) {
      try {
        rules = new Intl.PluralRules(locale)
      }
      catch {
        rules = new Intl.PluralRules('en')
      }
      this.#plurals.set(locale, rules)
    }
    return forms[rules.select(count)] ?? forms.other
  }
}

type Leaf = string | ((params: TranslationParams) => string) | Record<string, string>

function language(locale: string): string {
  return locale.split('-')[0].toLowerCase()
}

function isPluralForms(value: unknown): value is Record<string, string> {
  return isPlainObject(value)
    && 'other' in value
    && Object.keys(value).every(key => PLURAL_KEYS.has(key))
}

function lookup(messages: Messages | undefined, key: string): Leaf | undefined {
  let current: unknown = messages
  for (const segment of key.split('.')) {
    if (!isPlainObject(current) || !(segment in current))
      return undefined
    current = current[segment]
  }
  if (typeof current === 'string' || typeof current === 'function' || isPluralForms(current))
    return current as Leaf
  return undefined
}

function interpolate(template: string, params: TranslationParams): string {
  return template.replace(PLACEHOLDER_RE, (match, name: string) => params[name] === undefined || params[name] === null
    ? match
    : String(params[name]))
}

/** 把 glob 模块记录或对象形式的翻译整理为 `[locale, messages]` */
function parseLang(input: LangInput | undefined): Array<[string, Record<string, unknown>]> {
  if (!input)
    return []
  const entries = Object.entries(input)
  if (!entries.some(([key]) => key.includes('/')))
    return entries.map(([locale, messages]) => [locale, messages as Record<string, unknown>])

  return entries
    .sort(([a], [b]) => a.localeCompare(b))
    .flatMap(([path, mod]): Array<[string, Record<string, unknown>]> => {
      const match = LANG_PATH_RE.exec(path)
      if (!match)
        return []
      // lang/en/admin/users.ts → { admin: { users: {...} } }
      const nested = match[2].split('/').reduceRight<unknown>((value, segment) => ({ [segment]: value }), unwrapDefault(mod))
      return [
        [match[1], nested as Record<string, unknown>],
      ]
    })
}

let fallback: I18nManager | undefined
let standalone: I18nManager | undefined

/** @internal */
export function setI18nManager(manager: I18nManager | undefined): void {
  fallback = manager
}

/** 当前应用的多语言管理器；应用未注册时返回一个只含框架内置翻译、未启用的实例 */
export function useI18n(): I18nManager {
  const container = getRequestStore()?.container
  if (container?.has(I18nManager))
    return container.make(I18nManager)
  return fallback ?? (standalone ??= new I18nManager())
}

/** 当前请求的语言（ctx.locale）；未注册多语言时为 config/i18n.ts 的默认语言或 en */
export function requestLocale(ctx: HttpContext): string {
  const scoped = scope.getStore()
  if (scoped)
    return scoped
  if (ctx.container.has(I18nManager) || fallback)
    return useI18n().requestLocale(ctx)
  return requestLocales.get(ctx) ?? ctx.config.get<string>('i18n.defaultLocale', defaultI18nConfig.defaultLocale)
}

/** 设置请求的语言（ctx.setLocale） */
export function setRequestLocale(ctx: HttpContext, locale: string): void {
  requestLocales.set(ctx, locale)
}

/** 是否需要翻译框架消息（已注册多语言且存在 config/i18n.ts） */
export function i18nEnabled(): boolean {
  const container = getRequestStore()?.container
  if (container?.has(I18nManager))
    return container.make(I18nManager).enabled
  return fallback?.enabled ?? false
}

/** 翻译：`t('messages.welcome', { name })`、`t('messages.apples', { count: 3 })` */
export function t<K extends TranslationKey>(key: K, params?: TranslationParams): string {
  return useI18n().translate(key, params)
}

/**
 * 多语言门面：
 *
 * ```ts
 * I18n.t('messages.welcome', { name })
 * I18n.locale()                       // 当前语言
 * I18n.setLocale('zh-CN')
 * await I18n.withLocale('zh-CN', () => Mail.to(user.email).send(WelcomeMail, user))
 * ```
 */
export const I18n = {
  t,
  locale: (): string => useI18n().locale,
  setLocale: (locale: string): void => useI18n().setLocale(locale),
  withLocale: <T>(locale: string, fn: () => T): T => useI18n().withLocale(locale, fn),
  has: (key: string, locale?: string): boolean => useI18n().has(key, locale),
  locales: (): string[] => useI18n().locales(),
  load: (locale: string, messages: Record<string, unknown>): I18nManager => useI18n().load(locale, messages),
}
