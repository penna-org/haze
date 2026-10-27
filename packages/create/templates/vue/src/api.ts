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

/** 开发时同源请求由 Vite 转给后端，生产环境由同一个 Node 进程处理，无需配置代理 */
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { 'content-type': 'application/json', ...init.headers },
  })
  const body = await res.json() as ApiResponse<T>
  if (body.code !== 0)
    throw new ApiError(body)
  return body.data
}
