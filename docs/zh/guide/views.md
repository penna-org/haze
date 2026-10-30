# 视图（TSX）

hazejs 用 TSX 在服务端渲染 HTML。JSX 运行时内置在 `@hazejs/core` 中：零依赖，把元素渲染为转义后的 HTML 字符串，所有部署预设（包括 Cloudflare Workers）都能使用。JSX 由 Vite 插件在构建时编译，运行时不需要加载模板引擎。

视图适合服务端渲染的页面、HTML 邮件、落地页、维护页和简单的管理页面。完整的单页前端请使用 [Vue / React 全栈模板](./fullstack)。

## 第一个视图

视图放在 `app/view` 下（`haze make:view Home` 生成 `app/view/Home.tsx`）：

```tsx
// app/view/Home.tsx
export default function Home(props: { name: string }) {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <title>Home</title>
      </head>
      <body>
        <h1>Hello, {props.name}</h1>
      </body>
    </html>
  )
}
```

在路由或控制器中渲染。响应为 `text/html`，不经过 [统一响应格式](./responses)：

```tsx
// app/controller/HomeController.tsx
import type { HttpContext } from '@hazejs/core'
import Home from '~/app/view/Home'

export class HomeController {
  index(ctx: HttpContext) {
    return ctx.view(<Home name="Ada" />)
  }
}
```

路由文件通常是 `.ts`，这时传入组件与属性，不写 JSX：

```ts
// route/web.ts
import { defineRoutes } from '@hazejs/core'
import Home from '~/app/view/Home'

export default defineRoutes((r) => {
  r.get('/', ctx => ctx.view(Home, { name: 'Ada' })).name('home')
})
```

`api` 模板已经这样配置：`GET /` 渲染 `app/view/Welcome.tsx`。

## 渲染

| API | 说明 |
| --- | --- |
| `ctx.view(<Home />, init?)` | 渲染 JSX 节点 |
| `ctx.view(Home, props, init?)` | 渲染组件并传入属性 |
| `ctx.view('admin/Dashboard', props, init?)` | 按名称渲染 `app/view/admin/Dashboard.tsx`（默认导出，或与文件同名的具名导出：`export function Dashboard`） |
| `view(...)` | 与 `ctx.view()` 相同，用于拿不到 `ctx` 的代码 |
| `return <Home />` | 处理器或中间件返回的 JSX 节点同样渲染为 HTML |
| `renderToString(node)` | 渲染为字符串，例如邮件正文 |

`init` 为 `{ status?, headers? }`。不传 `status` 时使用 `ctx.status()` 设置的状态码（默认 200）：

```tsx
return ctx.view(<NotFound />, { status: 404, headers: { 'cache-control': 'no-store' } })
```

渲染结果以 `<html` 开头时自动在前面加上 `<!DOCTYPE html>`。其它情况使用 `Doctype` 组件：`<><Doctype /><html>…</html></>`。

渲染时抛出的异常与其它异常一样交给 [异常处理器](./errors)。

## 布局与组件

布局就是接收 `children` 的组件：

```tsx
// app/view/Layout.tsx
import type { ViewChild } from '@hazejs/core'

export default function Layout(props: { title: string, children?: ViewChild }) {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <title>{props.title}</title>
      </head>
      <body>
        <main>{props.children}</main>
      </body>
    </html>
  )
}
```

```tsx
return ctx.view(<Layout title="文章"><PostList posts={posts} /></Layout>)
```

组件可以是 `async` 函数。同级的异步组件并发执行，输出顺序不变：

```tsx
async function LatestPosts() {
  const posts = await Post.order('id', 'desc').limit(5).select()
  return <ul>{posts.map(post => <li>{post.title}</li>)}</ul>
}
```

## 转义与原始 HTML

文本与属性值始终会转义。需要插入可信的 HTML 时，使用 `rawHtml()`（或 [邮件工具](./mail) 中的 `html` 模板），或者 `dangerouslySetInnerHTML`：

```tsx
import { rawHtml } from '@hazejs/core'

<div>{rawHtml(markdownToHtml(post.body))}</div>
<style dangerouslySetInnerHTML={{ __html: css }} />
```

`<script>` 与 `<style>` 中的内容和普通文本一样会被转义，内联代码请使用 `dangerouslySetInnerHTML`。

## 属性

| 值 | 输出 |
| --- | --- |
| `disabled` / `disabled={true}` | `disabled` |
| `false`、`null`、`undefined` | 不输出该属性 |
| `class` / `className` | 字符串、数组或 `{ active: isActive }` 对象：`class={['btn', { active }]}` |
| `style` | 字符串或对象；驼峰属性名转为连字符，数值加 `px`（`opacity`、`lineHeight`、`zIndex` 等无单位属性除外） |
| `htmlFor` | `for` |
| 函数（`onClick`） | 不输出——没有客户端运行时 |
| Promise | 等待结果后再输出元素 |

空元素（`<br>`、`<img>`、`<input>`、`<meta>` 等）没有结束标签。常用的 HTML 属性都有类型，任何元素都可以使用 `data-*`、`aria-*`、`hx-*`（htmx）与 `x-*`（Alpine.js）。自定义元素的名称必须包含连字符（`<my-widget>`）。

## 请求上下文

组件在请求内执行，常用的工具都能直接使用：

```tsx
import { t, useHttpContext, useView } from '@hazejs/core'

export default function Nav() {
  const ctx = useHttpContext()
  const { locale } = useView()
  return <nav data-path={ctx.path} lang={locale}>{t('messages.home')}</nav>
}
```

`useView()` 返回 `{ ctx, locale, t, old, csrfToken }`，其中 `csrfToken` 是返回 Promise 的函数（`await csrfToken()`）。`t()` 按请求的语言翻译，详见 [多语言](./localization)。

## 表单

`csrfField()` 输出 [`csrf` 中间件](./security) 校验的隐藏字段 `_token`。它是异步的，作为 JSX 子节点直接使用即可（Promise 会被等待）；在 JSX 之外使用时需要 `await`。`old(field, fallback?)` 读取 `flashInput()` 闪存的输入，提交失败后可以回填表单：

```tsx
// app/view/PostForm.tsx
import { csrfField, old } from '@hazejs/core'

export default function PostForm(props: { error?: string }) {
  return (
    <form method="post" action="/posts">
      {csrfField()}
      {props.error && <p class="error">{props.error}</p>}
      <input name="title" value={old('title')} />
      <button type="submit">保存</button>
    </form>
  )
}
```

```ts
// route/web.ts
import { defineRoutes, flashInput } from '@hazejs/core'
import PostForm from '~/app/view/PostForm'

export default defineRoutes((r) => {
  r.group({ middleware: ['session', 'csrf'] }, (r) => {
    r.get('/posts/new', ctx => ctx.view(PostForm, {}))
    r.post('/posts', async (ctx) => {
      const body = await ctx.body<{ title?: string }>()
      if (!body.title) {
        await flashInput() // 闪存请求体（不含 _token 与密码字段）
        return ctx.redirect('/posts/new')
      }
      return ctx.redirect('/posts')
    })
  })
})
```

`old()` 需要已启动的会话（`session` 中间件），没有会话时返回 fallback。

## 邮件正文

`defineMail()` 的内容可以用同样的组件渲染：

```tsx
// app/mail/WelcomeMail.tsx
import { defineMail, renderToString } from '@hazejs/core'
import Welcome from '~/app/view/mail/Welcome'

export default defineMail(async (payload: { name: string }) => ({
  subject: `欢迎，${payload.name}`,
  html: await renderToString(<Welcome name={payload.name} />),
}))
```

## JSX 的编译方式

Vite 插件在开发、测试与构建时，把后端源码目录（`srcDir`）下的 `.tsx` / `.jsx` 文件按自动运行时、`jsxImportSource: '@hazejs/core'` 编译。它只作用于后端（SSR）环境，因此全栈模板的前端仍使用自己的 JSX 配置：`src/` 下的 React 组件照常由 React 编译。自己声明了 pragma（`/** @jsxImportSource react */`）的文件不做处理。

类型检查时，后端的 `tsconfig` 需要相同的设置（模板中已经配置：`api` 为 `tsconfig.json`，`vue` / `react` 为 `tsconfig.server.json`）：

```json
{
  "compilerOptions": {
    "jsx": "react-jsx",
    "jsxImportSource": "@hazejs/core"
  },
  "include": ["**/*.ts", "**/*.tsx"]
}
```

开发时修改视图与修改其它后端文件一样，会热替换应用。

::: tip
不支持流式渲染与客户端水合：视图渲染为完整的字符串后一次发出。
:::
