# @hazejs/auto-import

Auto imports for hazejs: use controllers, services, events, jobs and library APIs without writing import statements — with full type support (classes usable as types, generics, default exports).

## Install

```bash
pnpm add -D @hazejs/auto-import
```

## Usage

```ts
import { createAutoImport } from '@hazejs/auto-import'

const autoImport = createAutoImport({
  srcDir: '/path/to/project',
  // directories to scan, relative to srcDir (defaults to app/<kind>/** and modules/*/app/<kind>/**)
  dirs: ['app/controller/**', 'app/service/**'],
  // imports from packages
  imports: [
    {
      from: 'valibot',
      imports: [
        ['*', 'v']
      ]
    }
  ],
})

await autoImport.scan()
await autoImport.writeDts('/path/to/project/.haze/types/auto-imports.d.ts')

// in a Vite plugin, after TypeScript is stripped
const result = await autoImport.transform(code, id)
```

```ts
// app/controller/UserController.ts — no imports needed
export class UserController {
  private users: UserService = inject(UserService)

  async store(ctx: HttpContext) {
    await UserRegistered.emit({ name: 'Ada' })
  }
}
```

Part of [hazejs](https://github.com/penna-org/haze) — see the main README for documentation.

## License

[MIT](./LICENSE)
