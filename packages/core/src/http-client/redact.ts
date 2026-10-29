/** 遥测中隐藏的请求 / 响应头（可用 config/http.ts 的 redactHeaders 追加） */
export const SENSITIVE_HEADERS: readonly string[] = [
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'x-auth-token',
  'x-csrf-token',
  'x-xsrf-token',
]

/** 值需要隐藏的查询参数名 */
const SENSITIVE_QUERY_RE = /token|secret|password|passwd|signature|credential|api[-_]?key|^key$|^sig$|^auth$|^code$/i

const REDACTED = '[REDACTED]'

/** 去掉 URL 中的用户名 / 密码，并隐藏敏感查询参数的值（错误信息与遥测使用） */
export function redactUrl(input: string): string {
  let url: URL
  try {
    url = new URL(input)
  }
  catch {
    return input
  }
  let changed = false
  if (url.username || url.password) {
    // 用户信息中的方括号会被编码，这里不带方括号
    url.username = url.username && 'REDACTED'
    url.password = url.password && 'REDACTED'
    changed = true
  }
  if (url.search) {
    const params = new URLSearchParams(url.search)
    const sensitive = [
      ...new Set(params.keys()),
    ].filter(key => SENSITIVE_QUERY_RE.test(key))
    if (sensitive.length) {
      for (const key of sensitive)
        params.set(key, REDACTED)
      url.search = params.toString().replaceAll(encodeURIComponent(REDACTED), REDACTED)
      changed = true
    }
  }
  return changed
    ? url.href
    : input
}

export function redactHeaders(headers: Headers, redact: ReadonlySet<string>): Record<string, string> {
  const result: Record<string, string> = {}
  headers.forEach((value, key) => {
    result[key] = redact.has(key)
      ? REDACTED
      : value
  })
  return result
}
