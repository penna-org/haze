---
'@hazejs/core': minor
'@hazejs/vite': minor
'@hazejs/cli': minor
'create-hazejs': minor
---

Localization: `lang/<locale>/*.ts`, `t()` / `ctx.locale` with query, cookie and Accept-Language detection, plurals, translated validation errors (valibot, zod) and framework error messages in English and Chinese, localized mail, and typed translation keys. API resources with `defineResource()`, `when()` / `whenLoaded()` and paginated collections, plus `haze make:resource`. Signed route URLs (`router.signedUrl()`, `temporarySignedUrl()`, the `signed` middleware) and `Crypt` (AES-256-GCM from APP_KEY, key rotation with `APP_PREVIOUS_KEYS`).
