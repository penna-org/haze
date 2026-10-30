import { i18nEnabled, useI18n } from './manager'

/** 框架抛出的默认消息 → 翻译键（`http.*`）；业务中自定义的消息不会被替换 */
const KNOWN: Record<string, string> = {
  'Bad Request': '400',
  'Unauthorized': '401',
  'Unauthenticated': '401',
  'Unauthenticated.': '401',
  '未登录或登录已过期': '401',
  'Forbidden': '403',
  'This action is unauthorized.': '403',
  '无权执行此操作': '403',
  'Not Found': '404',
  'File not found': '404',
  'Method Not Allowed': '405',
  'Conflict': '409',
  'Request Entity Too Large': '413',
  'Payload Too Large': '413',
  'Page Expired': '419',
  'CSRF token 无效或已过期，请刷新页面后重试': '419',
  'Validation Failed': '422',
  'Too Many Requests': '429',
  '请求过于频繁，请稍后再试': '429',
  'Internal Server Error': '500',
  'Service Unavailable': '503',
  'Invalid signature.': 'invalid_signature',
  'Invalid or expired signature': 'invalid_signature',
  // @hazejs/orm 的 UniqueConstraintException
  '数据已存在（违反唯一约束）': 'unique_violation',
  'The application is down for maintenance. Please check back soon.': 'maintenance',
}

const ROUTE_NOT_FOUND_RE = /^Cannot find any route matching \[(\w+)\] (.*)$/
const BODY_TOO_LARGE_RE = /^Request body size exceeds the limit/

/**
 * 翻译框架内置的 HTTP 异常消息（存在 config/i18n.ts 时生效，可在 lang/<locale>/http.ts 中覆盖）。
 * 没有对应翻译键的消息原样返回。
 */
export function localizeHttpMessage(status: number, message: string): string {
  if (!i18nEnabled())
    return message
  const i18n = useI18n()
  const route = ROUTE_NOT_FOUND_RE.exec(message)
  if (route)
    return i18n.translate('http.route_not_found', { method: route[1], path: route[2] })
  if (i18n.has(message))
    return i18n.translate(message)
  const key = KNOWN[message]
    ?? (BODY_TOO_LARGE_RE.test(message)
      ? '413'
      : undefined)
    ?? (!message || message === 'HTTPError'
      ? String(status)
      : undefined)
  return key && i18n.has(`http.${key}`)
    ? i18n.translate(`http.${key}`)
    : message
}
