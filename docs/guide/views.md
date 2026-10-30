# Views (TSX)

hazejs renders HTML on the server with TSX. The JSX runtime is part of `@hazejs/core`: it has no dependencies, turns elements into escaped HTML strings, and works on every deployment preset, Cloudflare Workers included. JSX is compiled at build time by the Vite plugin, so there is no template engine to load at runtime.

Views suit server-rendered pages, HTML emails, landing pages, maintenance pages and small admin screens. For a full single-page frontend, use the [Vue or React full-stack templates](./fullstack).

## A first view

Views live in `app/view` (`haze make:view Home` creates `app/view/Home.tsx`):

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

Render it from a route or a controller. The response is `text/html` and skips the [JSON envelope](./responses):

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

Route files are usually plain `.ts`. Pass the component and its props instead of JSX:

```ts
// route/web.ts
import { defineRoutes } from '@hazejs/core'
import Home from '~/app/view/Home'

export default defineRoutes((r) => {
  r.get('/', ctx => ctx.view(Home, { name: 'Ada' })).name('home')
})
```

The `api` template ships this setup: `GET /` renders `app/view/Welcome.tsx`.

## Rendering

| API | Description |
| --- | --- |
| `ctx.view(<Home />, init?)` | Render a JSX node |
| `ctx.view(Home, props, init?)` | Render a component with props |
| `ctx.view('admin/Dashboard', props, init?)` | Render `app/view/admin/Dashboard.tsx` by name (default export, or a named export matching the file name: `export function Dashboard`) |
| `view(...)` | Same as `ctx.view()`, for code without `ctx` |
| `return <Home />` | A JSX node returned from a handler or middleware is rendered as HTML too |
| `renderToString(node)` | Render to a string, for example for mail bodies |

`init` is `{ status?, headers? }`. Without `status`, the status set with `ctx.status()` is used (default 200):

```tsx
return ctx.view(<NotFound />, { status: 404, headers: { 'cache-control': 'no-store' } })
```

When the rendered HTML starts with `<html`, `<!DOCTYPE html>` is added in front. Elsewhere, use the `Doctype` component: `<><Doctype /><html>…</html></>`.

Errors thrown while rendering go to the [exception handler](./errors) like any other error.

## Layouts and components

Layouts are components that take `children`:

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
return ctx.view(<Layout title="Posts"><PostList posts={posts} /></Layout>)
```

Components can be `async`. Siblings render concurrently, and the output keeps their order:

```tsx
async function LatestPosts() {
  const posts = await Post.order('id', 'desc').limit(5).select()
  return <ul>{posts.map(post => <li>{post.title}</li>)}</ul>
}
```

## Escaping and raw HTML

Text and attribute values are always escaped. To insert HTML you trust, use `rawHtml()` (or an `html` template from the [mail helpers](./mail)), or `dangerouslySetInnerHTML`:

```tsx
import { rawHtml } from '@hazejs/core'

<div>{rawHtml(markdownToHtml(post.body))}</div>
<style dangerouslySetInnerHTML={{ __html: css }} />
```

The content of `<script>` and `<style>` is escaped like any other text, so inline code goes through `dangerouslySetInnerHTML`.

## Attributes

| Value | Output |
| --- | --- |
| `disabled` / `disabled={true}` | `disabled` |
| `false`, `null`, `undefined` | Attribute omitted |
| `class` / `className` | String, array or `{ active: isActive }` object: `class={['btn', { active }]}` |
| `style` | String or object; camelCase names become kebab-case, numbers get `px` (except unitless properties such as `opacity`, `lineHeight`, `zIndex`) |
| `htmlFor` | `for` |
| Functions (`onClick`) | Omitted — there is no client-side runtime |
| Promises | Awaited before the element is written |

Void elements (`<br>`, `<img>`, `<input>`, `<meta>`, …) have no closing tag. Elements get attribute types for the common HTML attributes, and `data-*`, `aria-*`, `hx-*` (htmx) and `x-*` (Alpine.js) are accepted on every element. Custom elements must contain a hyphen (`<my-widget>`).

## Request context

Components run inside the request, so the usual helpers work:

```tsx
import { t, useHttpContext, useView } from '@hazejs/core'

export default function Nav() {
  const ctx = useHttpContext()
  const { locale } = useView()
  return <nav data-path={ctx.path} lang={locale}>{t('messages.home')}</nav>
}
```

`useView()` returns `{ ctx, locale, t, old, csrfToken }`; `csrfToken` is a function returning a promise (`await csrfToken()`). `t()` translates with the request locale; see [Localization](./localization).

## Forms

`csrfField()` writes the hidden `_token` input that the [`csrf` middleware](./security) checks. It is async, which is fine as a JSX child (promises are awaited); outside JSX, `await` it. `old(field, fallback?)` reads the input flashed by `flashInput()`, so a form can be filled again after a failed submission:

```tsx
// app/view/PostForm.tsx
import { csrfField, old } from '@hazejs/core'

export default function PostForm(props: { error?: string }) {
  return (
    <form method="post" action="/posts">
      {csrfField()}
      {props.error && <p class="error">{props.error}</p>}
      <input name="title" value={old('title')} />
      <button type="submit">Save</button>
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
        await flashInput() // flashes the request body, without _token and password fields
        return ctx.redirect('/posts/new')
      }
      return ctx.redirect('/posts')
    })
  })
})
```

`old()` needs a started session (the `session` middleware); without one it returns the fallback.

## Mail bodies

`defineMail()` content can be rendered with the same components:

```tsx
// app/mail/WelcomeMail.tsx
import { defineMail, renderToString } from '@hazejs/core'
import Welcome from '~/app/view/mail/Welcome'

export default defineMail(async (payload: { name: string }) => ({
  subject: `Welcome, ${payload.name}`,
  html: await renderToString(<Welcome name={payload.name} />),
}))
```

## How JSX is compiled

The Vite plugin compiles `.tsx` / `.jsx` files inside the backend source directory (`srcDir`) with the automatic runtime and `jsxImportSource: '@hazejs/core'`, in dev, tests and builds. It only does this for the backend (SSR) environment, so the frontend of the full-stack templates keeps its own JSX: React components under `src/` still compile with React. A file that declares its own pragma (`/** @jsxImportSource react */`) is left alone.

For type checking, the backend `tsconfig` sets the same runtime (already done in the templates — `tsconfig.json` in `api`, `tsconfig.server.json` in `vue` / `react`):

```json
{
  "compilerOptions": {
    "jsx": "react-jsx",
    "jsxImportSource": "@hazejs/core"
  },
  "include": ["**/*.ts", "**/*.tsx"]
}
```

Editing a view in dev reloads the app like any other backend file.

::: tip
There is no streaming render and no client-side hydration: a view is rendered to a string and sent in one piece.
:::
