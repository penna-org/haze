import type { Application, ApplicationOptions, RouteRegistrar, ViewChild } from '../src'
import { afterEach, describe, expect, it } from 'vitest'
import { createApplication, csrfField, defineI18nConfig, defineRoutes, Doctype, flashInput, html, isViewNode, old, rawHtml, renderToString, t, useHttpContext, useView, view } from '../src'

const apps: Application[] = []
afterEach(async () => {
  for (const app of apps.splice(0))
    await app.dispose()
})

const KEY = 'k'.repeat(32)

async function boot(routes: RouteRegistrar, options: ApplicationOptions & { config?: Record<string, unknown> } = {}) {
  const app = await createApplication({
    mode: 'test',
    env: false,
    ...options,
    config: {
      app: { key: KEY },
      logger: { level: 'silent' },
      ...options.config,
    },
    routes: [
      defineRoutes(routes),
    ],
  })
  apps.push(app)
  return app
}

function Greeting(props: { name: string }) {
  return <p class="greeting">{`Hello, ${props.name}`}</p>
}

function Layout(props: { title: string, children?: ViewChild }) {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <title>{props.title}</title>
      </head>
      <body>{props.children}</body>
    </html>
  )
}

describe('jsx runtime', () => {
  it('escapes text and attribute values', async () => {
    const evil = '<script>alert("x")</script>'
    expect(await renderToString(<div title={evil} data-x={`"'&`}>{evil}</div>)).toBe(
      '<div title="&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;" data-x="&quot;&#39;&amp;">&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;</div>',
    )
    // 非法的属性名被丢弃（防止属性注入）
    expect(await renderToString(<div {...{ 'onclick="x"': 1, 'ok': 'y' }} />)).toBe('<div ok="y"></div>')
  })

  it('renders attributes: boolean, class, className, style, functions', async () => {
    expect(await renderToString(
      <input type="checkbox" checked disabled={false} name="a" value={undefined} />,
    )).toBe('<input type="checkbox" checked name="a">')
    expect(await renderToString(<div className="a" />)).toBe('<div class="a"></div>')
    expect(await renderToString(
      <div class={[
        'btn',
        { active: true, hidden: false },
        null,
      ]}
      />,
    )).toBe('<div class="btn active"></div>')
    expect(await renderToString(
      <div style={{
        'fontSize': 14,
        'lineHeight': 1.5,
        'marginTop': 0,
        'color': 'red',
        '--gap': '4px',
        'display': undefined,
      }}
      />,
    ))
      .toBe('<div style="font-size:14px;line-height:1.5;margin-top:0;color:red;--gap:4px"></div>')
    expect(await renderToString(<div style="color: blue" />)).toBe('<div style="color: blue"></div>')
    expect(await renderToString(<label htmlFor="email">Email</label>)).toBe('<label for="email">Email</label>')
    // 事件处理函数无法在服务端渲染
    expect(await renderToString(
      <button
        type="button"
        {...{
          onClick: () => {},
        }}
      >
        Go
      </button>,
    )).toBe('<button type="button">Go</button>')
  })

  it('renders void elements, fragments, arrays and skips empty values', async () => {
    expect(await renderToString(
      <>
        <br />
        <img src="/a.png" alt="" />
        <hr />
      </>,
    )).toBe('<br><img src="/a.png" alt=""><hr>')
    const items = ['a', 'b']
    expect(await renderToString(
      <ul>
        {items.map(item => <li key={item}>{item}</li>)}
        {null}
        {false}
        {undefined}
        {0}
        {1n}
      </ul>,
    )).toBe('<ul><li>a</li><li>b</li>01</ul>')
  })

  it('renders components, layouts and async components', async () => {
    async function UserName(props: { id: number }) {
      await new Promise(resolve => setTimeout(resolve, 5))
      return (
        <strong>
          user-
          {props.id}
        </strong>
      )
    }
    const order: string[] = []
    async function Slow(props: { ms: number, label: string }) {
      await new Promise(resolve => setTimeout(resolve, props.ms))
      order.push(props.label)
      return props.label
    }
    const html = await renderToString(
      <Layout title="Home">
        <Greeting name="Ada" />
        <UserName id={1} />
        <Slow ms={20} label="first" />
        <Slow ms={1} label="second" />
      </Layout>,
    )
    expect(html).toBe('<html lang="en"><head><meta charset="utf-8"><title>Home</title></head><body><p class="greeting">Hello, Ada</p><strong>user-1</strong>firstsecond</body></html>')
    // 同级的异步组件并发执行，输出顺序不变
    expect(order).toEqual(['second', 'first'])
    // 没有异步组件时节点是惰性的，渲染结果是普通字符串
    expect(isViewNode(<Greeting name="x" />)).toBe(true)
  })

  it('inserts raw HTML and the doctype', async () => {
    expect(await renderToString(
      <div>
        {rawHtml('<b>bold</b>')}
        {html`<i>${'<x>'}</i>`}
      </div>,
    )).toBe('<div><b>bold</b><i>&lt;x&gt;</i></div>')
    expect(await renderToString(<div dangerouslySetInnerHTML={{ __html: '<em>hi</em>' }} />)).toBe('<div><em>hi</em></div>')
    expect(await renderToString(
      <>
        <Doctype />
        <html><body /></html>
      </>,
    )).toBe('<!DOCTYPE html><html><body></body></html>')
    // style / script 的内容同样会转义，内联代码使用 dangerouslySetInnerHTML
    expect(await renderToString(<style dangerouslySetInnerHTML={{ __html: 'a > b { color: red }' }} />)).toBe('<style>a > b { color: red }</style>')
  })

  it('awaits promise children and attribute values', async () => {
    const value = Promise.resolve('later')
    expect(await renderToString(<input value={value} />)).toBe('<input value="later">')
    expect(await renderToString(<p>{Promise.resolve(<b>x</b>)}</p>)).toBe('<p><b>x</b></p>')
  })
})

describe('views in requests', () => {
  it('ctx.view() returns HTML with status and headers, bypassing the JSON envelope', async () => {
    const app = await boot((r) => {
      r.get('/', ctx => ctx.view(<Layout title="Home"><Greeting name="Ada" /></Layout>))
      r.get('/created', ctx => ctx.view(<p>created</p>, {
        status: 201,
        headers: { 'x-view': '1' },
      }))
      r.get('/component', ctx => ctx.view(Greeting, { name: 'Grace' }))
      r.get('/status', (ctx) => {
        ctx.status(202)
        return ctx.view(<p>accepted</p>)
      })
    })
    const home = await app.request('/')
    expect(home.status).toBe(200)
    expect(home.headers.get('content-type')).toBe('text/html; charset=utf-8')
    // 以 <html> 开头的页面自动补上 doctype
    expect(await home.text()).toBe('<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Home</title></head><body><p class="greeting">Hello, Ada</p></body></html>')

    const created = await app.request('/created')
    expect([
      created.status,
      created.headers.get('x-view'),
      await created.text(),
    ]).toEqual([201, '1', '<p>created</p>'])
    expect(await (await app.request('/component')).text()).toBe('<p class="greeting">Hello, Grace</p>')
    expect((await app.request('/status')).status).toBe(202)
  })

  it('renders a JSX node returned from a controller (formatter bypass) and view() helper', async () => {
    const app = await boot((r) => {
      r.get('/node', () => <Greeting name="node" />)
      r.get('/async', async () => {
        await Promise.resolve()
        return <Layout title="Async"><span>ok</span></Layout>
      })
      r.get('/helper', () => view(<p>helper</p>, { status: 203 }))
      r.get('/data', () => ({ ok: true }))
      r.get('/error', () => <Boom />)
    })
    function Boom(): ViewChild {
      throw new Error('render failed')
    }
    const node = await app.request('/node')
    expect(node.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(await node.text()).toBe('<p class="greeting">Hello, node</p>')
    expect(await (await app.request('/async')).text()).toContain('<title>Async</title>')
    const helper = await app.request('/helper')
    expect([helper.status, await helper.text()]).toEqual([203, '<p>helper</p>'])
    // 其它返回值仍然使用统一格式
    expect(await (await app.request('/data')).json()).toEqual({
      code: 0,
      message: 'ok',
      data: { ok: true },
    })
    // 渲染时抛出的异常交给异常处理器
    const error = await app.request('/error')
    expect(error.status).toBe(500)
    expect((await error.json() as any).code).toBe(500)
  })

  it('renders named views from app/view and gives components the request context', async () => {
    function Profile(props: { name: string }) {
      const ctx = useHttpContext()
      const { locale } = useView()
      return (
        <p data-path={ctx.path} data-locale={locale}>
          {props.name}
          {' '}
          {t('http.404')}
        </p>
      )
    }
    const app = await boot((r) => {
      r.get('/profile', ctx => ctx.view('users/Profile', { name: 'Ada' }))
      r.get('/missing', ctx => ctx.view('Nope'))
    }, {
      views: {
        '/app/view/users/Profile.tsx': () => Promise.resolve({ default: Profile }),
      },
      config: {
        app: { key: KEY },
        logger: { level: 'silent' },
        i18n: defineI18nConfig({
          defaultLocale: 'zh-CN',
          locales: ['zh-CN', 'en'],
        }),
      },
    })
    expect(await (await app.request('/profile')).text()).toBe('<p data-path="/profile" data-locale="zh-CN">Ada 未找到</p>')
    expect((await app.request('/missing')).status).toBe(500)
  })

  it('csrfField() and old() work with the session and csrf middleware', async () => {
    function Form() {
      return (
        <form method="post" action="/posts">
          {csrfField()}
          <input name="title" value={old('title')} />
          <input name="body" value={old('body', 'default')} />
        </form>
      )
    }
    const app = await boot((r) => {
      r.get('/form', ctx => ctx.view(<Form />)).middleware('session')
      r.post('/posts', async (ctx) => {
        await flashInput()
        return ctx.redirect('/form')
      }).middleware(['session', 'csrf'])
    }, {
      config: {
        app: { key: KEY },
        logger: { level: 'silent' },
        // 测试模式默认不校验 CSRF，这里显式开启
        csrf: { testing: true },
      },
    })
    const first = await app.request('/form')
    const page = await first.text()
    const token = /name="_token" value="([^"]+)"/.exec(page)?.[1]
    expect(token).toBeTruthy()
    expect(page).toContain('<input name="title"><input name="body" value="default">')
    const cookie = first.headers.getSetCookie().map(item => item.split(';')[0]).join('; ')

    // 不带 token 被 csrf 中间件拒绝
    const rejected = await app.request('/posts', {
      method: 'POST',
      headers: { 'cookie': cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: 'title=Hi',
    })
    expect(rejected.status).toBe(419)

    const posted = await app.request('/posts', {
      method: 'POST',
      headers: { 'cookie': cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ _token: token!, title: 'Hi <there>', password: 'secret' }).toString(),
    })
    expect(posted.status).toBe(302)
    const next = posted.headers.getSetCookie().map(item => item.split(';')[0]).join('; ') || cookie
    const again = await (await app.request('/form', {
      headers: { cookie: next },
    })).text()
    // 旧输入经过转义回填；密码与 _token 不闪存
    expect(again).toContain('<input name="title" value="Hi &lt;there&gt;">')
    expect(again).not.toContain('secret')
  })
})
