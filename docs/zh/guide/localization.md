# 多语言

hazejs 内置了一套轻量、无依赖的多语言支持。翻译写在普通的 TypeScript（或 JSON）文件里；请求的语言从查询参数、Cookie 或 `Accept-Language` 中检测；`t()` 在请求内的任何地方都能用，控制器、服务、邮件都一样。有了 `config/i18n.ts` 之后，校验错误和框架自带的错误消息也会一起翻译。

```ts
t('messages.welcome', { name: 'Ada' })   // "Welcome, Ada!" / "欢迎，Ada！"
t('messages.apples', { count: 3 })       // "3 apples"
```

## 翻译文件

在 `lang/` 下为每种语言建一个目录，与 `config/` 同级（全栈项目为 `server/lang/`）。每个文件默认导出一个嵌套对象，文件名就是键的第一段：

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

| 键 | 来源 |
|----|------|
| `messages.welcome` | `lang/<语言>/messages.ts` 中的 `welcome` |
| `messages.profile.updated` | 嵌套对象展开为点号路径 |
| `admin.users.title` | `lang/<语言>/admin/users.ts` 中的 `title`（子目录同样展开） |

JSON 文件（`lang/en/errors.json`）用法相同。句子需要逻辑判断时，值也可以写成函数 `(params) => string`。

### 插值与复数

`{name}` 占位符会被同名参数替换，没有提供的占位符原样保留。

键全部是复数类别（`zero`、`one`、`two`、`few`、`many`、`other`）的对象就是复数消息。传入 `count` 后，按当前语言的 `Intl.PluralRules` 选择形式；`count` 为 `0` 且提供了 `zero` 时用 `zero`，其余情况找不到对应形式就用 `other`。

### 回退

当前语言缺少某个键时，先尝试语言部分（`zh-CN` → `zh`），再尝试 `fallbackLocale`。都找不到时 `t()` 返回键本身，漏翻的地方一眼就能看出来。

## 配置

```ts
// config/i18n.ts
import { defineI18nConfig } from '@hazejs/core'

export default defineI18nConfig({
  defaultLocale: 'zh-CN',
  fallbackLocale: 'en',
  locales: ['zh-CN', 'en'],
  detect: ['query:lang', 'cookie:locale', 'header'],
})
```

| 选项 | 默认值 | 说明 |
|------|--------|------|
| `defaultLocale` | `'en'` | 检测不到语言时使用的语言 |
| `fallbackLocale` | 同 `defaultLocale` | 缺少翻译时查找的语言 |
| `locales` | `lang/` 下的语言 + `defaultLocale` | 支持的语言，检测结果只会是其中之一 |
| `detect` | `['query:lang', 'cookie:locale', 'header']` | 检测顺序，见下文 |

没有这个文件时 `t()` 照常可用。这个文件决定是否翻译校验错误和框架消息，所以不使用多语言的项目，响应内容保持不变。

## 请求的语言

请求中第一次读取语言时，按 `detect` 的顺序依次尝试：

| 来源 | 示例 | 读取 |
|------|------|------|
| `query:<名字>` | `query:lang` | `?lang=zh-CN` |
| `cookie:<名字>` | `cookie:locale` | 名为 `locale` 的 Cookie |
| `header` | | `Accept-Language`，按 q 值排序 |
| `header:<名字>` | `header:x-locale` | 自定义请求头 |

取到的值先与 `locales` 做不区分大小写的精确匹配，再按语言部分匹配：只配置了 `zh-CN` 这一种中文时，`zh`、`zh_cn`、`zh-TW` 都会得到 `zh-CN`。不支持的值直接跳过。

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
    ctx.setLocale(user!.locale)   // 本次请求后续都使用用户设置的语言
    return { message: t('messages.profile.updated') }
  }
}
```

`t()` 与 `I18n` 门面读取的都是当前请求的语言，服务层不需要拿到 `ctx`：

```ts
import { I18n, t } from '@hazejs/core'

I18n.locale()                  // 当前语言
I18n.setLocale('zh-CN')        // 请求内只影响本次请求
I18n.has('messages.welcome')
I18n.locales()                 // 支持的语言
```

### 请求之外

队列任务、命令和定时任务使用 `defaultLocale`。需要临时切换时用 `I18n.withLocale()` 包起来，整个调用链（包括 `await` 之后）都生效：

```ts
await I18n.withLocale(user.locale, async () => {
  await notifyUser(user)       // 这里面的 t() 都使用 user.locale
})
```

## 校验错误

存在 `config/i18n.ts` 时，`.validate()` 与 `validate()` 产生的 422 错误会翻译成请求的语言。hazejs 能识别 valibot 与 zod 4 的问题类型（必填、类型、email / url / uuid、长度与数值上下限、固定长度、picklist / enum、MIME 类型、文件大小等），映射到框架内置的 `en` 与 `zh-CN` 消息：

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

在 `lang/<语言>/validation.ts` 中可以覆盖任意消息，也可以给字段起一个可读的名字：

```ts
// lang/zh-CN/validation.ts
export default {
  required: '请填写{attribute}',
  min: { string: '{attribute}至少 {min} 个字' },
  attributes: { email: '邮箱', name: '名字' },
  // 按字段覆盖：validation.custom.<路径>.<规则>
  custom: { password: { min: '密码至少 {min} 位' } },
}
```

可用的占位符有 `{attribute}`、`{min}`、`{max}`、`{size}`、`{values}` 和 `{value}`。完整的键可以查看 `@hazejs/core` 导出的 `frameworkMessages` 中的 `en` / `zh-CN`。

schema 中自己写的消息保持原样；如果这条消息本身是一个翻译键，则会被翻译：

```ts
v.pipe(v.string(), v.check(isFree, 'validation.nickname_taken'))   // 翻译
v.pipe(v.string(), v.maxLength(200, '简介太长'))                    // 原样保留
```

其它校验库（arktype 等）的问题保留它们自己的消息。

## 框架消息

框架内置的错误消息（找不到路由、401、403、404、419、429、500、签名无效，以及 `@hazejs/orm` 的唯一约束冲突 `unique_violation`）也按同样的方式翻译，可在 `lang/<语言>/http.ts` 中覆盖：

```ts
// lang/zh-CN/http.ts
export default {
  403: '你没有权限执行这个操作',
  route_not_found: '这里什么都没有：[{method}] {path}',
}
```

业务里传给异常的消息不会被替换，除非它是一个翻译键：`throw new NotFoundException('errors.post_missing')` 会被翻译。

## 邮件

邮件渲染函数在邮件的语言下执行，直接用 `t()` 即可：

```ts
// app/mail/WelcomeMail.ts
export default defineMail((payload: { name: string }) => ({
  subject: t('messages.welcome', { name: payload.name }),
  html: mailLayout({ body: html`<p>${t('messages.profile.updated')}</p>` }),
}))
```

邮件的语言依次取：`.locale()`、`defineMail` 的 `locale` 选项、当前语言（请求内即请求的语言）：

```ts
await Mail.to(user.email).locale(user.locale).send(WelcomeMail, { name: user.name })
await Mail.to(user.email).locale('zh-CN').queue(WelcomeMail, { name: user.name })
```

排队发送的邮件在入队时就已渲染，语言不会丢失。

## 翻译键的类型

开发服务器（以及 `haze typegen`）会根据 `lang/en`（没有时取第一个语言目录）生成 `.haze/types/i18n.d.ts`。之后 `t()` 与 `ctx.t()` 只接受已有的键，包括框架内置的 `validation.*` 与 `http.*`：

```ts
t('messages.welcome', { name })   // 正确
t('messages.welcom')              // 类型错误
```

动态拼接的键可以断言一下：`t(key as TranslationKey)`。
