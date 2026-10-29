# @hazejs/oauth

## 0.2.0

### Minor Changes

- [`2a5031b`](https://github.com/penna-org/haze/commit/2a5031b801e01a23781828e61e76c22bb9554450) Thanks [@aibayanyu20](https://github.com/aibayanyu20)! - Authentication extensions. New package `@hazejs/oauth` for social login (GitHub, Google, Apple, Microsoft, GitLab, Discord, WeChat, WeChat Official Accounts, QQ, DingTalk, Feishu / Lark, WeCom, Alipay and any OpenID Connect provider) with state, PKCE, nonce and `id_token` verification. Core adds personal access tokens (`token` guard, `ctx.auth.tokenCan()`, `abilities:` / `ability:` middleware), signed email verification (`sendEmailVerification()`, `verifyEmail()`, `verified` middleware), password reset (`PasswordReset.sendLink()` / `reset()`), TOTP two-factor authentication with recovery codes and a session challenge flow (`TwoFactor`), passkeys on top of the optional `@simplewebauthn/server` (`Passkeys`) and an `authRoutes()` helper. `@hazejs/orm` adds database stores for all of them, and `haze make:auth-tables` generates their schema. New projects include token, email verification, password reset and GitHub login endpoints.

### Patch Changes

- Updated dependencies [[`2a5031b`](https://github.com/penna-org/haze/commit/2a5031b801e01a23781828e61e76c22bb9554450), [`1feefd3`](https://github.com/penna-org/haze/commit/1feefd347c59e86ddbb215b0cddb28172a6bce75), [`704870c`](https://github.com/penna-org/haze/commit/704870c8282875ad5a2d81012a96049e31e77b59), [`d9523dc`](https://github.com/penna-org/haze/commit/d9523dce1bb88b486d6ba78a41d7760c9d57b70a), [`bae4c9c`](https://github.com/penna-org/haze/commit/bae4c9c44fd056515610a32cc5077b499d536671), [`8f7e23e`](https://github.com/penna-org/haze/commit/8f7e23eb48f366ddd8847eb3492cf4b47dbf29a4), [`899ac66`](https://github.com/penna-org/haze/commit/899ac66ec154510893708a3505e956cda0e22eac), [`8437ae9`](https://github.com/penna-org/haze/commit/8437ae94e16fef8c96ba64e96fbfad4946c75eec), [`175e253`](https://github.com/penna-org/haze/commit/175e253f1f42dd5466a7c4409c46b04939bbebce), [`b0eaecc`](https://github.com/penna-org/haze/commit/b0eaeccea3472d7b8d095e2f9cc66706c35b8d56), [`743e0c6`](https://github.com/penna-org/haze/commit/743e0c646b305b1532357fe09a51e6665ac8fb33)]:
  - @hazejs/core@0.2.0
