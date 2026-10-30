---
'@hazejs/vite': patch
---

`haze dev`, `haze build` and `haze preview` only treat a project as full-stack when its `vite.config.*` imports `@hazejs/vite`; a `vite.config.ts` that just holds tooling settings (vite-plus `run` tasks, lint or test options in a monorepo package) no longer switches a backend-only project into full-stack mode. Backend-only builds empty the output directory first (when it lies inside the project), so stale files from an earlier build no longer end up in presets that place the server in a subdirectory, such as the docker build context.
