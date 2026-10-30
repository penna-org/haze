# Localization

hazejs ships a small, dependency-free i18n layer. Translations live in plain TypeScript (or JSON) files, the request locale is detected from the query string, a cookie or `Accept-Language`, and `t()` works anywhere in the request — controllers, services, mails. With `config/i18n.ts` in place, validation errors and the framework's own error messages are translated too.

```ts
t('messages.welcome', { name: 'Ada' })   // "Welcome, Ada!" / "欢迎，Ada！"
t('messages.apples', { count: 3 })       // "3 apples"
```

## Translation files

Put one directory per locale under `lang/`, next to `config/` (in full-stack projects, `server/lang/`). Each file default-exports a nested object; the file name is the first segment of the key:

```ts
// lang/en/messages.ts
export default {
  welcome: 'Welcome, {name}!',
  apples: { zero: 'No apples', one: 'One apple', other: '{count} apples' },
  profile: {
    updated: 'Your profile has been updated.',
  },
}
```

```ts
// lang/zh-CN/messages.ts
export default {
  welcome: '欢迎，{name}！',
  apples: { other: '{count} 个苹果' },
  profile: {
    updated: '资料已更新',
  },
}
```

| Key | Comes from |
|-----|------------|
| `messages.welcome` | `lang/<locale>/messages.ts` → `welcome` |
| `messages.profile.updated` | nested objects become dotted paths |
| `admin.users.title` | `lang/<locale>/admin/users.ts` → `title` (sub-directories nest too) |

JSON files (`lang/en/errors.json`) work the same way. A value can also be a function `(params) => string` when a sentence needs real logic.

### Interpolation and plurals

`{name}` placeholders are replaced with the matching parameter; unknown placeholders are left as is.

An object whose keys are plural categories (`zero`, `one`, `two`, `few`, `many`, `other`) is a plural message. Pass `count` and the form is chosen with `Intl.PluralRules` for the current locale. `zero` is used when `count` is `0` and the form exists; `other` is the fallback.

### Fallbacks

When a key is missing in the current locale, hazejs tries the language part (`zh-CN` → `zh`), then `fallbackLocale`. If nothing matches, `t()` returns the key itself, which makes missing translations easy to spot.

## Configuration

```ts
// config/i18n.ts
import { defineI18nConfig } from '@hazejs/core'

export default defineI18nConfig({
  defaultLocale: 'en',
  fallbackLocale: 'en',
  locales: ['en', 'zh-CN'],
  detect: ['query:lang', 'cookie:locale', 'header'],
})
```

| Option | Default | Description |
|--------|---------|-------------|
| `defaultLocale` | `'en'` | Locale used when detection finds nothing |
| `fallbackLocale` | `defaultLocale` | Locale consulted when a key is missing |
| `locales` | locales under `lang/` + `defaultLocale` | Supported locales; detection only returns one of these |
| `detect` | `['query:lang', 'cookie:locale', 'header']` | Detection order, see below |

`t()` works without this file. The file is what turns on translation of validation errors and framework messages, so projects that don't use i18n keep their current responses.

## The request locale

The locale is detected the first time it is read in a request, trying each source in `detect` order:

| Source | Example | Reads |
|--------|---------|-------|
| `query:<name>` | `query:lang` | `?lang=zh-CN` |
| `cookie:<name>` | `cookie:locale` | the `locale` cookie |
| `header` | | `Accept-Language`, honoring q-values |
| `header:<name>` | `header:x-locale` | a custom header |

Values are matched against `locales` case-insensitively, then by language: `zh`, `zh_cn` and `zh-TW` all resolve to `zh-CN` when that is the only Chinese locale. Unsupported values are skipped.

```ts
export class ProfileController {
  show(ctx: HttpContext) {
    return {
      locale: ctx.locale,                                   // "zh-CN"
      greeting: ctx.t('messages.welcome', { name: 'Ada' }), // "欢迎，Ada！"
    }
  }

  async update(ctx: HttpContext) {
    const user = await ctx.auth.user()
    ctx.setLocale(user!.locale)   // the rest of this request uses the user's language
    return { message: t('messages.profile.updated') }
  }
}
```

`t()` and the `I18n` facade read the locale of the current request, so services don't need `ctx`:

```ts
import { I18n, t } from '@hazejs/core'

I18n.locale()                  // current locale
I18n.setLocale('zh-CN')        // inside a request: this request only
I18n.has('messages.welcome')
I18n.locales()                 // supported locales
```

### Outside requests

Queue jobs, commands and scheduled tasks use `defaultLocale`. Wrap code in `I18n.withLocale()` to switch for one call chain (it follows `await`):

```ts
await I18n.withLocale(user.locale, async () => {
  await notifyUser(user)       // every t() in here uses user.locale
})
```

## Validation messages

With `config/i18n.ts` present, the 422 errors produced by `.validate()` and `validate()` are translated into the request locale. hazejs recognizes the issue types of valibot and zod 4 (required, type, email / url / uuid, min / max length and value, exact length, picklist / enum, MIME type, file size …) and maps them to framework messages in `en` and `zh-CN`:

```json
{
  "code": 422,
  "message": "提交的数据不合法",
  "data": null,
  "errors": [
    { "target": "body", "path": "email", "message": "邮箱必须是有效的邮箱地址" },
    { "target": "body", "path": "name", "message": "name至少为 3 个字符" }
  ]
}
```

Override any message, and give fields readable names, in `lang/<locale>/validation.ts`:

```ts
// lang/zh-CN/validation.ts
export default {
  required: '请填写{attribute}',
  min: { string: '{attribute}至少 {min} 个字' },
  attributes: { email: '邮箱', name: '名字' },
  // per-field: validation.custom.<path>.<rule>
  custom: { password: { min: '密码至少 {min} 位' } },
}
```

Available placeholders are `{attribute}`, `{min}`, `{max}`, `{size}`, `{values}` and `{value}`. The full list of keys is in `en` / `zh-CN` of `@hazejs/core`'s framework messages (`frameworkMessages`).

Custom messages written in a schema are kept as they are. If such a message is a translation key, it is translated:

```ts
v.pipe(v.string(), v.check(isFree, 'validation.nickname_taken'))   // translated
v.pipe(v.string(), v.maxLength(200, 'Bio is too long'))            // kept
```

Issues from other validators (arktype …) keep their own messages.

## Framework messages

The framework's built-in error messages — unmatched routes, 401, 403, 404, 419, 429, 500, invalid signatures and `@hazejs/orm` unique constraint violations (`unique_violation`) — are translated the same way. Override them in `lang/<locale>/http.ts`:

```ts
// lang/en/http.ts
export default {
  403: 'You are not allowed to do that.',
  route_not_found: 'Nothing here: [{method}] {path}',
}
```

Messages you pass to exceptions yourself are left alone, unless they are translation keys: `throw new NotFoundException('errors.post_missing')` is translated.

## Mail

Everything in a mail's render function runs in the mail's locale, so `t()` just works:

```ts
// app/mail/WelcomeMail.ts
export default defineMail((payload: { name: string }) => ({
  subject: t('messages.welcome', { name: payload.name }),
  html: mailLayout({ body: html`<p>${t('messages.profile.updated')}</p>` }),
}))
```

The locale is, in order: `.locale()` on the pending mail, the `locale` option of `defineMail`, then the current locale (the request's, inside a request):

```ts
await Mail.to(user.email).locale(user.locale).send(WelcomeMail, { name: user.name })
await Mail.to(user.email).locale('zh-CN').queue(WelcomeMail, { name: user.name })
```

Queued mails are rendered when they are queued, so the locale is preserved.

## Typed keys

The dev server (and `haze typegen`) writes `.haze/types/i18n.d.ts` from `lang/en` (or the first locale directory). `t()` and `ctx.t()` then only accept known keys, including the framework's `validation.*` and `http.*`:

```ts
t('messages.welcome', { name })   // ok
t('messages.welcom')              // type error
```

Cast for dynamic keys: `t(key as TranslationKey)`.
