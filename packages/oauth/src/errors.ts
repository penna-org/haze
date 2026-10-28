import { HttpException } from '@hazejs/core'

/**
 * 第三方登录失败：用户拒绝授权、授权码无效 / 已使用、第三方接口返回错误等。
 * 默认 400，`code` 为第三方的错误码（如 access_denied、invalid_grant、40029）。
 */
export class OAuthException extends HttpException {
  /** 驱动名 */
  readonly provider: string

  constructor(provider: string, message: string, options: { code?: string | number, status?: number, data?: unknown, cause?: unknown } = {}) {
    super(`[${provider}] ${message}`, {
      status: options.status ?? 400,
      code: options.code ?? 'oauth_error',
      data: options.data,
      cause: options.cause,
    })
    this.provider = provider
  }
}

/** state 缺失、过期或与发起时不一致（可能是 CSRF，或 Cookie 未随回调带回） */
export class InvalidStateException extends OAuthException {
  constructor(provider: string, message = 'Invalid or expired OAuth state') {
    super(provider, message, { code: 'invalid_state' })
  }
}
