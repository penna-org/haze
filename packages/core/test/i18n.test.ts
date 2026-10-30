import type { Application, ApplicationOptions, RouteRegistrar } from '../src'
import type { LangInput, TranslationPath } from '../src/i18n/manager'
import * as v from 'valibot'
import { afterAll, describe, expect, expectTypeOf, it } from 'vitest'
import { z } from 'zod'
import { ConflictException, createApplication, defineMail, defineRoutes, ForbiddenException, Mail, MailManager, NotFoundException, validate } from '../src'
import { I18n, I18nManager, setI18nManager, t } from '../src/i18n/manager'

const lang: LangInput = {
  // glob 形式：键为文件路径，子目录展开为嵌套键
  '/lang/en/messages.ts': {
    default: {
      welcome: 'Welcome, {name}!',
      apples: { zero: 'No apples', one: 'One apple', other: '{count} apples' },
      only_en: 'Only in English',
      greet: (params: Record<string, unknown>) => `Hi ${String(params.name).toUpperCase()}`,
    },
  },
  '/lang/zh-CN/messages.ts': {
    default: {
      welcome: '欢迎，{name}！',
      apples: { other: '{count} 个苹果' },
    },
  },
  '/lang/zh-CN/validation.ts': {
    default: {
      attributes: { email: '邮箱' },
      custom: {
        name: { min: '名字太短了，至少 {min} 个字' },
      },
      nickname_taken: '昵称已被占用',
    },
  },
  '/lang/zh-CN/admin/users.json': {
    default: { title: '用户管理' },
  },
  '/lang/en/http.ts': {
    default: { 403: 'Nope.' },
  },
}

const apps: Application[] = []
afterAll(async () => {
  for (const app of apps)
    await app.dispose()
  setI18nManager(undefined)
})

async function boot(routes: RouteRegistrar, options: ApplicationOptions & { config?: Record<string, unknown>, lang?: LangInput } = {}) {
  const app = await createApplication({
    mode: 'test',
    env: false,
    ...options,
    config: {
      logger: { level: 'silent' },
      ...options.config,
    },
    routes: [
      defineRoutes(routes),
    ],
    // 接线之前用提供者注册（正式接线在 Application.boot 中完成）
    providers: [
      {
        register(container, app) {
          const i18n = new I18nManager(app.config, options.lang ?? lang)
          container.instance(I18nManager, i18n)
          setI18nManager(i18n)
        },
      },
    ],
  })
  apps.push(app)
  return app
}

const i18nConfig = {
  i18n: {
    defaultLocale: 'en',
    fallbackLocale: 'en',
    locales: ['en', 'zh-CN'],
  },
}

describe('locale detection', () => {
  const app = boot(r => r.get('/locale', ctx => ({
    locale: ctx.locale,
    text: ctx.t('messages.welcome', { name: 'Ada' }),
  })), { config: i18nConfig })

  async function localeOf(path: string, headers: Record<string, string> = {}) {
    return (await (await (await app).request(path, { headers })).json() as any).data
  }

  it('negotiates Accept-Language with q values and language fallback', async () => {
    expect(await localeOf('/locale', { 'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8' })).toEqual({ locale: 'zh-CN', text: '欢迎，Ada！' })
    expect((await localeOf('/locale', { 'accept-language': 'fr;q=1, en;q=0.4, zh;q=0.6' })).locale).toBe('zh-CN')
    expect((await localeOf('/locale', { 'accept-language': 'zh-TW' })).locale).toBe('zh-CN')
    expect((await localeOf('/locale', { 'accept-language': 'fr, *;q=0.1' })).locale).toBe('en')
    expect((await localeOf('/locale')).locale).toBe('en')
  })

  it('prefers the query parameter, then the cookie, then the header', async () => {
    expect((await localeOf('/locale?lang=zh-cn', { 'accept-language': 'en' })).locale).toBe('zh-CN')
    expect((await localeOf('/locale?lang=xx', { 'cookie': 'locale=zh-CN', 'accept-language': 'en' })).locale).toBe('zh-CN')
    expect((await localeOf('/locale', { 'cookie': 'locale=en', 'accept-language': 'zh-CN' })).locale).toBe('en')
  })

  it('follows a custom detect order and ctx.setLocale()', async () => {
    const custom = await boot(r => r.get('/l', (ctx) => {
      const before = ctx.locale
      ctx.setLocale('zh-CN')
      return {
        before,
        after: ctx.locale,
        text: t('messages.welcome', { name: 'Ada' }),
      }
    }), {
      config: {
        i18n: {
          defaultLocale: 'en',
          detect: ['header:x-locale'],
        },
      },
    })
    const res = await (await custom.request('/l?lang=zh-CN', {
      headers: { 'x-locale': 'en', 'accept-language': 'zh-CN' },
    })).json() as any
    expect(res.data).toEqual({ before: 'en', after: 'zh-CN', text: '欢迎，Ada！' })
  })
})

describe('translation', () => {
  const manager = new I18nManager(undefined, lang)

  it('interpolates, pluralizes and falls back', () => {
    expect(manager.translate('messages.welcome', { name: 'Ada' }, 'en')).toBe('Welcome, Ada!')
    expect(manager.translate('messages.apples', { count: 0 }, 'en')).toBe('No apples')
    expect(manager.translate('messages.apples', { count: 1 }, 'en')).toBe('One apple')
    expect(manager.translate('messages.apples', { count: 5 }, 'en')).toBe('5 apples')
    expect(manager.translate('messages.apples', { count: 1 }, 'zh-CN')).toBe('1 个苹果')
    // zh-CN 没有的键回退到 fallbackLocale（en）
    expect(manager.translate('messages.only_en', {}, 'zh-CN')).toBe('Only in English')
    // zh 按语言部分找到框架内置的中文
    expect(manager.translate('validation.required', { attribute: '名字' }, 'zh')).toBe('名字不能为空')
    expect(manager.translate('messages.greet', { name: 'ada' }, 'en')).toBe('Hi ADA')
    expect(manager.translate('admin.users.title', {}, 'zh-CN')).toBe('用户管理')
    // 找不到时返回键本身，未提供的占位符保留
    expect(manager.translate('messages.nope', {}, 'en')).toBe('messages.nope')
    expect(manager.translate('messages.welcome', {}, 'en')).toBe('Welcome, {name}!')
    // 命名空间不是叶子
    expect(manager.has('messages', 'en')).toBe(false)
    expect(manager.has('messages.welcome', 'zh-CN')).toBe(true)
  })

  it('derives dotted keys (plural forms are leaves)', () => {
    interface Shape {
      messages: { welcome: string, apples: { one: string, other: string }, nested: { deep: string } }
      http: { 404: string }
      fn: { greet: (params: object) => string }
    }
    expectTypeOf<TranslationPath<Shape>>().toEqualTypeOf<'messages.welcome' | 'messages.apples' | 'messages.nested.deep' | 'http.404' | 'fn.greet'>()
  })

  it('accepts plain objects and lists locales', () => {
    const plain = new I18nManager(undefined, {
      'zh-CN': {
        messages: { hi: '你好' },
      },
    })
    expect(plain.locales()).toEqual(['en', 'zh-CN'])
    expect(plain.translate('messages.hi', {}, 'zh-CN')).toBe('你好')
    expect(plain.match('ZH_cn')).toBe('zh-CN')
    expect(plain.negotiate('de-DE,de;q=0.9')).toBeUndefined()
  })

  it('switches locale with withLocale() and setLocale() outside requests', async () => {
    const app = await boot(() => {}, { config: i18nConfig })
    expect(app.make(I18nManager)).toBeInstanceOf(I18nManager)
    expect(I18n.locale()).toBe('en')
    const text = await I18n.withLocale('zh-CN', async () => {
      await Promise.resolve()
      return t('messages.welcome', { name: 'Ada' })
    })
    expect(text).toBe('欢迎，Ada！')
    expect(I18n.locale()).toBe('en')
    I18n.setLocale('zh-CN')
    expect(t('messages.apples', { count: 2 })).toBe('2 个苹果')
    I18n.setLocale('en')
  })
})

describe('validation messages', () => {
  const ValibotUser = v.object({
    name: v.pipe(v.string(), v.minLength(3)),
    email: v.pipe(v.string(), v.email()),
    age: v.pipe(v.number(), v.minValue(18)),
    role: v.picklist(['admin', 'member']),
    tags: v.pipe(v.array(v.string()), v.maxLength(2)),
    nickname: v.pipe(v.string(), v.check(value => value !== 'taken', 'validation.nickname_taken')),
    bio: v.pipe(v.string(), v.maxLength(5, '简介太长')),
  })
  const ZodUser = z.object({
    name: z.string().min(3),
    email: z.email(),
    age: z.number().min(18),
    role: z.enum(['admin', 'member']),
    tags: z.array(z.string()).max(2),
    nickname: z.string().refine(value => value !== 'taken', 'validation.nickname_taken'),
    bio: z.string().max(5, '简介太长'),
    code: z.string().length(4),
  })
  const input = {
    name: 'Al',
    email: 'nope',
    age: 3,
    role: 'root',
    tags: ['a', 'b', 'c'],
    nickname: 'taken',
    bio: 'too long',
    code: '1',
  }

  const app = boot((r) => {
    r.post('/valibot', () => 'ok').validate({ body: ValibotUser })
    r.post('/zod', () => 'ok').validate({ body: ZodUser })
    r.post('/missing', () => 'ok').validate({
      body: z.object({
        email: z.email(),
        title: z.string(),
      }),
    })
    r.post('/manual', async ctx => validate(v.object({
      title: v.string(),
    }), await ctx.body()))
  }, { config: i18nConfig })

  async function errors(path: string, body: unknown, locale: string) {
    const res = await (await app).request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'accept-language': locale },
      body: JSON.stringify(body),
    })
    expect(res.status).toBe(422)
    const json = await res.json() as any
    return {
      message: json.message,
      errors: Object.fromEntries(json.errors.map((e: { path: string, message: string }) => [e.path, e.message])),
    }
  }

  it('translates valibot issues', async () => {
    expect(await errors('/valibot', { ...input, name: 'Al' }, 'zh-CN')).toEqual({
      message: '提交的数据不合法',
      errors: {
        // validation.custom.name.min 覆盖
        name: '名字太短了，至少 3 个字',
        // validation.attributes.email 显示名
        email: '邮箱必须是有效的邮箱地址',
        age: 'age不能小于 18',
        role: '所选的role无效',
        tags: 'tags不能超过 2 项',
        // 消息是翻译键时翻译该键
        nickname: '昵称已被占用',
        // 自定义消息原样保留
        bio: '简介太长',
      },
    })
    const en = await errors('/valibot', input, 'en')
    expect(en.message).toBe('The given data was invalid.')
    expect(en.errors).toMatchObject({
      name: 'The name field must be at least 3 characters.',
      email: 'The email field must be a valid email address.',
      age: 'The age field must be at least 18.',
      tags: 'The tags field must not have more than 2 items.',
      nickname: 'validation.nickname_taken',
    })
  })

  it('translates zod issues', async () => {
    expect((await errors('/zod', input, 'zh-CN')).errors).toEqual({
      name: '名字太短了，至少 3 个字',
      email: '邮箱必须是有效的邮箱地址',
      age: 'age不能小于 18',
      role: '所选的role无效',
      tags: 'tags不能超过 2 项',
      nickname: '昵称已被占用',
      bio: '简介太长',
      code: 'code必须为 4 个字符',
    })
    expect((await errors('/zod', input, 'en')).errors.code).toBe('The code field must be 4 characters.')
  })

  it('reports missing fields as required (zod, valibot and validate())', async () => {
    expect((await errors('/missing', {}, 'zh-CN')).errors).toEqual({ email: '邮箱不能为空', title: 'title不能为空' })
    expect((await errors('/missing', { email: 'a@b.co', title: 1 }, 'en')).errors).toEqual({ title: 'The title field must be a string.' })
    expect((await errors('/manual', {}, 'zh-CN')).errors).toEqual({ title: 'title不能为空' })
  })

  it('keeps the validator messages when config/i18n.ts is absent', async () => {
    const plain = await boot(r => r.post('/v', () => 'ok').validate({ body: ValibotUser }))
    const res = await plain.request('/v', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'accept-language': 'zh-CN' },
      body: JSON.stringify(input),
    })
    const json = await res.json() as any
    expect(json.message).toBe('Validation Failed')
    expect(json.errors[0].message).toBe('Invalid length: Expected >=3 but received 2')
  })
})

describe('exception messages', () => {
  const app = boot((r) => {
    r.get('/forbidden', () => {
      throw new ForbiddenException()
    })
    r.get('/custom', () => {
      throw new NotFoundException('Post 42 is gone')
    })
    r.get('/keyed', () => {
      throw new NotFoundException('admin.users.title')
    })
    // @hazejs/orm 的 UniqueConstraintException 的默认消息
    r.get('/duplicate', () => {
      throw new ConflictException('数据已存在（违反唯一约束）', { code: 'unique_violation' })
    })
    r.get('/limited', () => ({ ok: true })).middleware('throttle:1,60')
  }, { config: i18nConfig })

  async function message(path: string, locale: string) {
    const res = await (await app).request(path, {
      headers: { 'accept-language': locale },
    })
    return [res.status, (await res.json() as any).message]
  }

  it('translates built-in messages and leaves custom ones alone', async () => {
    expect(await message('/forbidden', 'zh-CN')).toEqual([403, '无权执行此操作'])
    // lang/en/http.ts 覆盖
    expect(await message('/forbidden', 'en')).toEqual([403, 'Nope.'])
    expect(await message('/nope', 'zh-CN')).toEqual([404, '找不到与 [GET] /nope 匹配的路由'])
    expect(await message('/custom', 'zh-CN')).toEqual([404, 'Post 42 is gone'])
    expect(await message('/keyed', 'zh-CN')).toEqual([404, '用户管理'])
    expect(await message('/duplicate', 'en')).toEqual([409, 'The record already exists.'])
    expect(await message('/duplicate', 'zh-CN')).toEqual([409, '数据已存在（违反唯一约束）'])
    await (await app).request('/limited')
    expect(await message('/limited', 'en')).toEqual([429, 'Too Many Requests'])
  })
})

describe('mail locale', () => {
  const WelcomeMail = defineMail((payload: { name: string }) => ({
    subject: t('messages.welcome', { name: payload.name }),
    text: t('messages.apples', { count: 3 }),
  }), { name: 'WelcomeMail' })
  const ChineseMail = defineMail(() => ({
    subject: t('messages.welcome', { name: 'Ada' }),
    text: '-',
  }), { locale: 'zh-CN' })

  it('renders mail content in the requested locale', async () => {
    const app = await boot(r => r.post('/send', async () => {
      await Mail.to('ada@example.com').send(WelcomeMail, { name: 'Ada' })
      return 'ok'
    }), { config: i18nConfig })
    const fake = app.make(MailManager).fake()

    await Mail.to('ada@example.com').locale('zh-CN').send(WelcomeMail, { name: 'Ada' })
    await Mail.to('ada@example.com').send(WelcomeMail, { name: 'Ada' })
    await Mail.to('ada@example.com').send(ChineseMail)
    await Mail.to('ada@example.com').locale('en').queue(ChineseMail)
    // 请求内默认使用请求的语言
    await app.request('/send', {
      method: 'POST',
      headers: { 'accept-language': 'zh-CN' },
    })

    expect(fake.sent.map(mail => [mail.message.subject, mail.message.text])).toEqual([
      ['欢迎，Ada！', '3 个苹果'],
      ['Welcome, Ada!', '3 apples'],
      ['欢迎，Ada！', '-'],
      ['欢迎，Ada！', '3 个苹果'],
    ])
    expect(fake.queued[0].message.subject).toBe('Welcome, Ada!')
  })
})
