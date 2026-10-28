# @hazejs/cli

The `haze` command line.

## Install

```bash
pnpm add -D @hazejs/cli
```

## Usage

```bash
haze dev                       # hot-reloading dev server (no restarts)
haze build --preset node       # node | bun | deno | docker | cloudflare | vercel | netlify | aws-lambda
haze preview                   # run the build output locally
haze make:controller Post --resource
haze db:generate && haze db:migrate
haze queue:work                # schedule:work, schedule:run, queue:failed, …
haze route:list
```

Part of [hazejs](https://github.com/penna-org/haze) — see the main README for documentation.

## License

[MIT](./LICENSE)
