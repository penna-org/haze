# @hazejs/testing

Vitest integration for hazejs: test app, HTTP client, `actingAs()` and database helpers.

## Install

```bash
pnpm add -D @hazejs/testing
```

## Usage

```ts
const t = useTestApp()

it('lists posts', async () => {
  const res = await (await t.actingAs(user)).get('/api/posts')
  expect(res.status).toBe(200)
})
```

Part of [hazejs](https://github.com/penna-org/haze) — see the main README for documentation.

## License

[MIT](./LICENSE)
