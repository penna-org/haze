# @hazejs/oauth

OAuth 2.0 / OpenID Connect social login for hazejs, in the spirit of Laravel Socialite: GitHub, Google, Apple, Microsoft (Entra ID), GitLab, Discord, WeChat (open platform and 公众号), QQ, DingTalk, Feishu / Lark, WeCom, Alipay and any OpenID Connect provider via discovery. State, PKCE and nonce are handled for you; `id_token`s are verified against the provider's JWKS.

## Install

```bash
pnpm add @hazejs/oauth
```

## Usage

```ts
// config/oauth.ts
import { env } from '@hazejs/core'
import { defineOAuthConfig } from '@hazejs/oauth'

export default defineOAuthConfig(() => ({
  providers: {
    // An empty clientId disables the provider
    github: {
      clientId: env('GITHUB_CLIENT_ID', ''),
      clientSecret: env('GITHUB_CLIENT_SECRET', ''),
      redirect: '/auth/github/callback',
    },
  },
}))
```

```ts
// app/controller/OAuthController.ts
import type { HttpContext } from '@hazejs/core'
import { OAuth } from '@hazejs/oauth'

export class OAuthController {
  redirect(ctx: HttpContext) {
    return OAuth.driver(ctx.param('provider')!).redirect(ctx)
  }

  async callback(ctx: HttpContext) {
    const user = await OAuth.driver(ctx.param('provider')!).user(ctx)
    // { provider, id, name, nickname, email, avatar, raw, token: { accessToken, refreshToken, expiresIn, idToken } }
    return user
  }
}
```

Part of [hazejs](https://github.com/penna-org/haze). See the [OAuth guide](https://penna-org.github.io/haze/guide/oauth) for every provider's options.

## License

[MIT](./LICENSE)
