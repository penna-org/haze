# Auto Imports

With auto imports on, you use controllers, services, events, jobs and the common hazejs APIs without writing `import` statements. The `haze()` Vite plugin adds the imports while it compiles your code, and a generated declaration file keeps editor completion and type checking intact: classes work as types, generics keep their constraints, default exports have names.

```ts
// route/api.ts: no imports
export default defineRoutes((r) => {
  r.get('/users/:id', [UserController, 'show'])
})

// app/controller/UserController.ts
export class UserController {
  private users = inject(UserService)

  show(ctx: HttpContext) {
    return this.users.find(Number(ctx.param('id'))) ?? notFound()
  }
}

function notFound(): never {
  throw new NotFoundException()
}
```

Auto imports are **off by default**. Imports you write by hand keep working, so you can turn them on in an existing project and remove imports gradually.

## Installation

```bash
pnpm add -D @hazejs/auto-import
```

```ts
// haze.config.ts
import { defineHazeConfig } from '@hazejs/vite'

export default defineHazeConfig({
  autoImport: true,
})
```

New projects can turn it on when they are created: `pnpm create hazejs my-app --auto-import` (or answer yes to the prompt).

Auto imports work wherever the `haze()` plugin runs: `haze dev`, `haze build`, Vitest with `defineHazeTestConfig()` and every CLI command that loads the app. In full-stack projects only the backend is affected: the frontend (Vite's `client` environment) gets no imports and does not see the declarations.

## What is imported

**Your code.** Every export of the files in these directories, including subdirectories, and the same directories inside local modules (`modules/<name>/app/...`):

`app/controller`, `app/service`, `app/repository`, `app/model`, `app/middleware`, `app/interceptor`, `app/validate`, `app/event`, `app/job`, `app/mail`, `app/notification`, `app/resource`

- Named exports keep their names: `export class UserService` → `UserService`.
- A default export takes its declared name (`export default class Post` → `Post`), or the file name when it is anonymous: `app/event/UserRegistered.ts` with `export default defineEvent(...)` → `UserRegistered`, `app/job/send-receipt.ts` → `sendReceipt`, `user/index.ts` → `user`.
- Type-only exports (`interface`, `type`) are available in type positions and never produce a runtime import.

Directories that the framework discovers by itself (`app/listener`, `app/policy`, `app/provider`, `config`, `route`) are not scanned: nothing imports them.

**Framework APIs.** Each installed `@hazejs/*` package that ships a preset adds a curated list of its APIs:

| Package | Examples |
|---------|----------|
| `@hazejs/core` | `defineRoutes`, `defineConfig`, `defineProvider`, `defineEvent`, `defineListener`, `defineJob`, `definePolicy`, the `define*Config` helpers, `env`, `inject`, `validate`, `useApp`, services such as `Config`, `Logger`, `Router`, `Cache`, `Queue`, `Mail`, `Hash`, `Events`, `Gate`, the HTTP exceptions, `ExceptionHandler`, `ResponseFormatter`, `HttpContext`, and types such as `Next`, `Middleware`, `ControllerMiddleware` |
| `@hazejs/orm` | `Model`, `Db`, `defineDatabaseConfig`, `defineFactory`, `transaction`, `databaseProvider`, `modelUserProvider`, the `database*Store` helpers, `refreshDatabase`, `ModelNotFoundException`, `ModelQuery`, `Paginated` |

The presets leave out names that would clash with Node.js or Web globals (`Storage` and `Lock` are global types in `@types/node`; import them from `@hazejs/core` by hand) and very generic lower-case helpers (`t`, `raw`, `when`, `cache`, `can`).

## Types

The plugin writes the global declarations to `.haze/types/auto-imports.d.ts`. Projects created with `create-hazejs` already include `.haze/types/**/*.d.ts` in `tsconfig.json`; add it if your project does not.

The file is updated when the dev server starts, when you add, rename or remove an export, and by `haze typegen`. `.haze` is git-ignored, so run `haze typegen` before `tsc` in CI:

```json
{
  "scripts": {
    "typecheck": "haze typegen && tsc --noEmit"
  }
}
```

Go to definition jumps to the original file. A name that is not in the list (a typo, or a file outside the scanned directories) is reported by TypeScript as usual.

## Configuration

`autoImport: true` uses the defaults. Pass an object to change them:

```ts
export default defineHazeConfig({
  autoImport: {
    // Scan app/support too (relative to srcDir). This replaces the default list.
    dirs: ['app/controller/**', 'app/service/**', 'app/support'],
    // Imports from other packages
    imports: [
      { from: 'valibot', imports: [['*', 'v']] }, // import * as v from 'valibot'
      { from: 'dayjs', imports: [['default', 'dayjs']] }, // import dayjs from 'dayjs'
      { from: 'zod', imports: ['z', { name: 'ZodType', type: true }] },
    ],
    // Framework presets: all installed @hazejs/* packages by default; [] turns them off
    presets: ['@hazejs/core'],
    // Names never auto-imported
    ignore: ['Logger'],
  },
})
```

| Option | Default | Description |
|--------|---------|-------------|
| `dirs` | the list above | Directory globs relative to `srcDir`. `app/service` scans only the first level, `app/service/**` includes subdirectories, a last segment with an extension is a file glob. Earlier entries win on name clashes. |
| `imports` | `[]` | `{ from, imports }` entries. An item is a name, `[name, as]` (`'default'` and `'*'` for default and namespace imports), or `{ name, as?, type? }` (`type: true` for type-only names). |
| `presets` | installed `@hazejs/*` packages with a preset | Package names. A preset is the default export of `<package>/auto-imports`: a `{ from, imports }` object or an array of them. Third-party packages can ship one too; list them here. |
| `ignore` | `[]` | Names that are never auto-imported. |
| `exclude` | `['database/schema/**', 'modules/*/database/schema/**']` | Files (globs relative to `srcDir`) that never get imports added. |

When the same name comes from two places, your directories win over `imports`, which win over presets, and the dev server prints a warning that lists both files. Rename one of them or add the name to `ignore`.

## Where auto imports do not work

Auto imports are added by Vite, so files that something else loads need regular imports:

- `haze.config.ts`, `vite.config.ts` and `vitest.config.ts` (loaded by Vite's config loader);
- `database/schema/*.ts` (loaded by drizzle-kit in `haze db:generate`), which is why it is excluded by default.

TypeScript cannot tell these files apart from the rest, so a missing import there only fails at runtime.

## Generated code

`haze make:*` reads `haze.config.ts`. With auto imports on, the generated files leave out every import that would be added automatically and keep the rest:

```ts
// haze make:policy Post — no imports
export default definePolicy(Post, {
  viewAny: allowGuest(() => true),
  // ...
})
```

## Tips

- Explicit imports still work and take precedence: when a file imports or declares a name, nothing is added for it.
- Imports are added after TypeScript is compiled, so a class used only as a type (`private users: UserService` with `inject()`) does not create a runtime import.
- Auto imports make it easy to create import cycles without noticing. `inject()` resolves dependencies lazily, so cycles between services are fine; code that runs when a module is loaded (such as `static middleware = [Authenticate]`) still needs the other module to be loaded first.
