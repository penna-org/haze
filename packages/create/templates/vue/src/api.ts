/** 后端统一响应格式 */
export interface ApiResponse<T> {
  code: number | string
  message: string
  data: T
  errors?: Array<{ path: string, message: string }>
}

export class ApiError extends Error {
  constructor(readonly response: ApiResponse<unknown>) {
    super(response.errors?.[0]?.message ?? response.message)
  }
}

function readCookie(name: string): string | undefined {
  const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`))
  return match
    ? decodeURIComponent(match[1])
    : undefined
}

/** CSRF：修改类请求带上 XSRF-TOKEN（没有时先向后端取一次） */
export async function csrfHeader(method: string): Promise<Record<string, string>> {
  if (['GET', 'HEAD', 'OPTIONS'].includes(method))
    return {}
  if (!readCookie('XSRF-TOKEN'))
    await fetch('/api/csrf-cookie')
  const token = readCookie('XSRF-TOKEN')
  return token
    ? { 'x-xsrf-token': token }
    : {}
}

/** 开发时同源请求由 Vite 转给后端，生产环境由同一个 Node 进程处理，无需配置代理 */
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...await csrfHeader((init.method ?? 'GET').toUpperCase()),
      ...init.headers,
    },
  })
  const body = await res.json() as ApiResponse<T>
  if (body.code !== 0)
    throw new ApiError(body)
  return body.data
}
