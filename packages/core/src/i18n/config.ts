/**
 * 语言检测来源（按顺序尝试，第一个能匹配到支持语言的生效）：
 * - `query:<name>`：查询参数，如 `query:lang` → `?lang=zh-CN`
 * - `cookie:<name>`：Cookie，如 `cookie:locale`
 * - `header`：按 Accept-Language 协商（支持 q 值）
 * - `header:<name>`：自定义请求头的值，如 `header:x-locale`
 */
export type LocaleDetector = `query:${string}` | `cookie:${string}` | `header:${string}` | 'header'

export interface I18nConfig {
  /** 默认语言，默认 `en` */
  defaultLocale: string
  /** 当前语言缺少翻译时回退的语言，默认等于 defaultLocale */
  fallbackLocale?: string
  /** 支持的语言；省略时为 lang/ 下的语言目录加上默认语言 */
  locales?: string[]
  /** 请求语言的检测顺序，默认 `['query:lang', 'cookie:locale', 'header']` */
  detect?: LocaleDetector[]
}

export const defaultI18nConfig: Required<Omit<I18nConfig, 'locales'>> & Pick<I18nConfig, 'locales'> = {
  defaultLocale: 'en',
  fallbackLocale: 'en',
  detect: ['query:lang', 'cookie:locale', 'header'],
}

/** `config/i18n.ts` 的默认导出 */
export function defineI18nConfig(config: Partial<I18nConfig> | (() => Partial<I18nConfig>)): Partial<I18nConfig> | (() => Partial<I18nConfig>) {
  return config
}
