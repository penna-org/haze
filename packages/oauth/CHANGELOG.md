# @hazejs/oauth

## 0.4.0

### Patch Changes

- Updated dependencies [[`a7d7a1b`](https://github.com/penna-org/haze/commit/a7d7a1b2c351570511883fe28cc743e2b86f5c0f)]:
  - @hazejs/core@0.4.0

## 0.3.0

### Patch Changes

- Updated dependencies [[`7b5e0a9`](https://github.com/penna-org/haze/commit/7b5e0a95b73edbeac5aa5570483b2cbe2daf2eb8), [`cb51e0a`](https://github.com/penna-org/haze/commit/cb51e0aa95ad258aee8cc11e41cabe09448c01de), [`a5fd5cf`](https://github.com/penna-org/haze/commit/a5fd5cfa6753af24f147959b29ef6af4a31c99c4), [`f46d960`](https://github.com/penna-org/haze/commit/f46d960fb67f600e402f3ba371f83c3a8f3592cb), [`ea86d01`](https://github.com/penna-org/haze/commit/ea86d0175adf24563dc62ce796e602a04fbe6dcd), [`940711c`](https://github.com/penna-org/haze/commit/940711c72b493eab636beb0fd034ff8f118165bc), [`a5fd5cf`](https://github.com/penna-org/haze/commit/a5fd5cfa6753af24f147959b29ef6af4a31c99c4), [`4da85a8`](https://github.com/penna-org/haze/commit/4da85a83107181f99b029837798be84cb7c8c92a), [`bd81767`](https://github.com/penna-org/haze/commit/bd817672b975e2475a7644214396915d5f247f9b), [`a5fd5cf`](https://github.com/penna-org/haze/commit/a5fd5cfa6753af24f147959b29ef6af4a31c99c4), [`a5fd5cf`](https://github.com/penna-org/haze/commit/a5fd5cfa6753af24f147959b29ef6af4a31c99c4), [`15e802d`](https://github.com/penna-org/haze/commit/15e802d5f341a9928720189ed49a9cba8ff168f2), [`a5fd5cf`](https://github.com/penna-org/haze/commit/a5fd5cfa6753af24f147959b29ef6af4a31c99c4)]:
  - @hazejs/core@0.3.0

## 0.2.0

### Minor Changes

- [`2a5031b`](https://github.com/penna-org/haze/commit/2a5031b801e01a23781828e61e76c22bb9554450) Thanks [@aibayanyu20](https://github.com/aibayanyu20)! - Authentication extensions. New package `@hazejs/oauth` for social login (GitHub, Google, Apple, Microsoft, GitLab, Discord, WeChat, WeChat Official Accounts, QQ, DingTalk, Feishu / Lark, WeCom, Alipay and any OpenID Connect provider) with state, PKCE, nonce and `id_token` verification. Core adds personal access tokens (`token` guard, `ctx.auth.tokenCan()`, `abilities:` / `ability:` middleware), signed email verification (`sendEmailVerification()`, `verifyEmail()`, `verified` middleware), password reset (`PasswordReset.sendLink()` / `reset()`), TOTP two-factor authentication with recovery codes and a session challenge flow (`TwoFactor`), passkeys on top of the optional `@simplewebauthn/server` (`Passkeys`) and an `authRoutes()` helper. `@hazejs/orm` adds database stores for all of them, and `haze make:auth-tables` generates their schema. New projects include token, email verification, password reset and GitHub login endpoints.

### Patch Changes

- Updated dependencies [[`2a5031b`](https://github.com/penna-org/haze/commit/2a5031b801e01a23781828e61e76c22bb9554450), [`1feefd3`](https://github.com/penna-org/haze/commit/1feefd347c59e86ddbb215b0cddb28172a6bce75), [`704870c`](https://github.com/penna-org/haze/commit/704870c8282875ad5a2d81012a96049e31e77b59), [`d9523dc`](https://github.com/penna-org/haze/commit/d9523dce1bb88b486d6ba78a41d7760c9d57b70a), [`bae4c9c`](https://github.com/penna-org/haze/commit/bae4c9c44fd056515610a32cc5077b499d536671), [`8f7e23e`](https://github.com/penna-org/haze/commit/8f7e23eb48f366ddd8847eb3492cf4b47dbf29a4), [`899ac66`](https://github.com/penna-org/haze/commit/899ac66ec154510893708a3505e956cda0e22eac), [`8437ae9`](https://github.com/penna-org/haze/commit/8437ae94e16fef8c96ba64e96fbfad4946c75eec), [`175e253`](https://github.com/penna-org/haze/commit/175e253f1f42dd5466a7c4409c46b04939bbebce), [`b0eaecc`](https://github.com/penna-org/haze/commit/b0eaeccea3472d7b8d095e2f9cc66706c35b8d56), [`743e0c6`](https://github.com/penna-org/haze/commit/743e0c646b305b1532357fe09a51e6665ac8fb33)]:
  - @hazejs/core@0.2.0
