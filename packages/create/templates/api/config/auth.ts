import { defineAuthConfig, env } from '@hazejs/core'
import { databasePasswordResetStore, databaseTokenStore, modelUserProvider } from '@hazejs/orm'
import { User } from '~/app/model/User'
import { passwordResetTokens, personalAccessTokens } from '~/database/schema/auth'

/**
 * 认证：guards 决定“怎么认”（jwt：Authorization: Bearer；session：会话 Cookie；token：个人访问令牌），
 * providers 决定“用户从哪来”。路由上用 .middleware('auth') / 'auth:api,token' 保护。
 */
export default defineAuthConfig(() => ({
  default: 'api',
  guards: {
    // 密钥默认为 APP_KEY；也可配置 algorithm: 'ES256' 与 privateKey / publicKey
    api: {
      driver: 'jwt',
      provider: 'users',
      expiresIn: env('JWT_TTL', '2h'),
    },
    // 个人访问令牌（脚本、CLI、第三方集成）：可吊销、带能力，服务端只保存摘要
    token: {
      driver: 'token',
      provider: 'users',
      store: databaseTokenStore(personalAccessTokens),
    },
    // 浏览器同源场景可改用 session：{ driver: 'session', provider: 'users' }
  },
  providers: {
    users: modelUserProvider(() => User, { username: 'email', password: 'password' }),
  },
  // 邮箱验证：链接由该路由名生成并签名（APP_KEY），设置 APP_URL 后为绝对链接
  verification: {
    route: 'api.auth.verification.verify',
    expire: '60m',
  },
  // 找回密码：邮件中的链接为前端页面 <APP_URL>/reset-password?token=...&email=...，页面再调用 /api/auth/reset-password
  passwords: {
    store: databasePasswordResetStore(passwordResetTokens),
    path: '/reset-password',
    expire: '60m',
    throttle: '60s',
  },
}))
