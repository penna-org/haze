# @hazejs/devtools

DevTools for hazejs, built on [devframe](https://devfra.me). Experimental.

![The module graph panel](https://raw.githubusercontent.com/penna-org/haze/main/docs/public/devtools/graph.png)

- **Panels** at `/__devtools/`: overview, module graph (events, listeners, jobs, schedules and shared middleware between modules, plus what happened at runtime), routes, request waterfalls with N+1 hints, AI calls and a prompt playground, scheduled tasks and queues, container and events, the OpenAPI docs, the `/__haze` dashboard and terminals.
- **MCP** at `/__devtools/__mcp`: the same information for coding agents.
- **Static report**: `haze devtools:report` bakes the app structure into a static site.
- **Vite DevTools**: in full-stack projects with `devtools: true` in `vite.config.ts`, the panels show up inside Vite DevTools.

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

Connect Claude Code to the MCP endpoint:

```bash
claude mcp add --transport http hazejs http://localhost:3000/__devtools/__mcp --header "Origin: http://localhost:3000"
```

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
    // mcp: true,        // MCP endpoint for coding agents
  },
  // devtools: false,    // turn it off
})
```

Part of [hazejs](https://github.com/penna-org/haze) — see the [DevTools guide](https://github.com/penna-org/haze/blob/main/docs/guide/devtools.md).

## License

[MIT](./LICENSE)
