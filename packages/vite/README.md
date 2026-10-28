# @hazejs/vite

Vite plugin for hazejs: hot-reloading backend, full-stack dev server, deployment presets and preview.

## Install

```bash
pnpm add -D @hazejs/vite
```

## Usage

```ts
// vite.config.ts
import { haze } from '@hazejs/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [
    haze()
  ]
})
```

In dev, requests to your backend routes are served by the app in `server/` (configurable in `haze.config.ts`); `vite build` emits `dist/client` + `dist/server`; `vite preview` runs the real build output for the selected preset.

Part of [hazejs](https://github.com/penna-org/haze) — see the main README for documentation.

## License

[MIT](./LICENSE)
