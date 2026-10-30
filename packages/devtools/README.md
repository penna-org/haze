# @hazejs/devtools

DevTools for hazejs, built on [devframe](https://devfra.me): an app overview, a searchable route table, the `/__haze` dev dashboard and terminals in one hub at `/__devtools/`. Experimental.

## Install

```bash
pnpm add -D @hazejs/devtools
```

`haze dev` (and the `haze()` Vite plugin in full-stack projects) picks it up automatically and prints the URL:

```
  ➜  Local:    http://localhost:3000/
  ➜  DevTools: http://localhost:3000/__devtools/
```

The first time a browser connects, enter the one-time code printed in the terminal (or open the printed link).

## Options

```ts
// haze.config.ts
import { defineHazeConfig } from '@hazejs/vite'

export default defineHazeConfig({
  devtools: {
    // base: '/__devtools/',
    // auth: true,       // one-time code on first connect
    // terminals: true,  // terminal panel
    // embedded: true,   // full-stack: floating dock in the frontend
  },
  // devtools: false,    // turn it off
})
```

Part of [hazejs](https://github.com/penna-org/haze) — see the [DevTools guide](https://github.com/penna-org/haze/blob/main/docs/guide/devtools.md).

## License

[MIT](./LICENSE)
