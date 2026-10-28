import { env } from '@hazejs/core'
import { defineOAuthConfig } from '@hazejs/oauth'

/**
 * 第三方登录（@hazejs/oauth）：clientId 为空时该登录方式关闭，对应路由返回 404。
 * GitHub：在 https://github.com/settings/developers 创建 OAuth App，
 * 回调地址填写 <APP_URL>/api/auth/github/callback，然后在 .env 中设置 GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET。
 * 其它平台（Google、Apple、微信、钉钉、飞书……）见文档“第三方登录”。
 */
export default defineOAuthConfig(() => ({
  providers: {
    github: {
      clientId: env('GITHUB_CLIENT_ID', ''),
      clientSecret: env('GITHUB_CLIENT_SECRET', ''),
      redirect: '/api/auth/github/callback',
    },
  },
}))
