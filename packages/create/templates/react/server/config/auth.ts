import { defineAuthConfig, env } from '@hazejs/core'
import { modelUserProvider } from '@hazejs/orm'
import { User } from '~/app/model/User'

/**
 * 认证：guards 决定“怎么认”（jwt：Authorization: Bearer；session：会话 Cookie），
 * providers 决定“用户从哪来”。路由上用 .middleware('auth') / 'auth:web,api' 保护。
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
    // 浏览器同源场景可改用 session：{ driver: 'session', provider: 'users' }
  },
  providers: {
    users: modelUserProvider(() => User, { username: 'email', password: 'password' }),
  },
}))
