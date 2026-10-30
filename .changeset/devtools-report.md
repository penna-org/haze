---
'@hazejs/devtools': minor
'@hazejs/vite': minor
'@hazejs/cli': minor
---

`haze devtools:report` writes the app structure (overview, module graph, routes, container and events) to a static site for CI artifacts and reviews (`buildReport()` in `@hazejs/devtools`). In full-stack projects that turn on Vite DevTools (`devtools: true` in `vite.config.ts`), the `haze()` plugin registers the hazejs panels inside Vite DevTools instead of serving its own at the same `/__devtools/` path (`setupViteDevtools()`). `@hazejs/vite` exports `importDevtools()`, and `devtools.mcp` turns the MCP endpoint off.
