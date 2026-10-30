---
'@hazejs/auto-import': minor
'@hazejs/vite': minor
'@hazejs/core': minor
'@hazejs/orm': minor
'@hazejs/cli': minor
'create-hazejs': minor
---

Add auto imports. With the new `@hazejs/auto-import` package installed and `autoImport: true` in `haze.config.ts` (off by default), controllers, services, repositories, models, middleware, validators, events, jobs, mail, notifications and resources (`app/<kind>/**` and `modules/*/app/<kind>/**`), plus a curated list of framework APIs from the new `@hazejs/core/auto-imports` and `@hazejs/orm/auto-imports` presets (`defineRoutes`, `inject`, `env`, `HttpContext`, the HTTP exceptions, `Model`, `Db`, …), can be used without import statements in the dev server, builds, tests and CLI commands. Imports are added after TypeScript is compiled (type-only usages add nothing), the dev server reloads when exports are added or removed, and global declarations are written to `.haze/types/auto-imports.d.ts` so classes work as types, generics keep their constraints and default exports get names. `autoImport` accepts `dirs`, `imports` (other packages, e.g. `{ from: 'valibot', imports: [['*', 'v']] }`), `presets` (default: every installed `@hazejs/*` package with a preset; `[]` turns them off), `ignore` and `exclude` (default: `database/schema/**`). `haze()` now returns an array of plugins (`plugins: [haze()]` is unchanged; use `haze()[0].api` for the plugin API), `haze typegen` always writes types, `haze make:*` leaves out imports that would be auto-imported, and `create-hazejs --auto-import` turns the option on in new projects.
