# Multi-Tenancy

hazejs can serve many tenants (customers, organizations, workspaces) from one application. Each request is matched to a tenant, and the framework then keeps the tenants apart:

- **cache**: keys get a per-tenant prefix;
- **file storage**: paths get a per-tenant directory;
- **sessions**: each tenant gets its own cookie name and keys;
- **queued jobs**: carry the tenant, and the worker restores it;
- **database**: a separate database per tenant, or one database with a `tenant_id` column that the ORM fills and filters for you.

Tenancy lives in `@hazejs/core`. The database parts are in [`@hazejs/orm`](./models).

::: tip Paths
Examples on this page use the API template layout (`app/...`, `config/...`). In a full-stack project these live under `server/`.
:::

## Configuration

```ts
// config/tenancy.ts
import { defineTenancyConfig } from '@hazejs/core'
import { Tenant } from '../app/model/Tenant'

export default defineTenancyConfig({
  // Tried in order; the first one that finds a key wins
  resolvers: ['subdomain', 'header'],
  domain: 'example.com', // acme.example.com → "acme"
  // Look the tenant up by key; null / undefined → 404
  find: key => Tenant.where('slug', key).find(),
  // Cache lookups in the process for a minute
  remember: '1m',
  // Routes that don't need a tenant
  except: ['/health', '/webhooks/*'],
})
```

| Option | Description |
| --- | --- |
| `resolvers` | How to find the tenant key: `'domain'`, `'subdomain'`, `'header'`, `'path'` or a function `(ctx) => string \| undefined`. Default `['header']` |
| `find` | `(key) => Tenant \| null`. Returning nothing answers **404** |
| `id` | The tenant's id, used for `tenant_id` and prefixes. Default `tenant.id` |
| `remember` | Cache `find()` results in the process (`'1m'`, seconds). Default off |
| `header` | Header for the `header` resolver. Default `X-Tenant` |
| `domain` | Base domain for the `subdomain` resolver |
| `path` | Prefix for the `path` resolver. Default `/t` |
| `centralDomains` | Hosts that never resolve a tenant, such as an admin site. With the subdomain resolver, `domain` itself is central |
| `except` | Paths that skip tenancy; a trailing `*` matches a prefix |
| `required` | When no key is found: `true` (default) answers 404; `false` continues without a tenant |
| `global` | `false` resolves tenants only on routes that use the `tenancy` middleware. Default `true` |
| `cache` | `false`, or `{ stores, prefix }`. Default: every store, prefix `tenant:<id>:` |
| `storage` | `false`, or `{ disks, prefix }`. Default: every disk, directory `tenants/<id>/` |
| `session` | `false` to share sessions between tenants. Default `true` |
| `queue` | `false` to stop jobs from carrying the tenant. Default `true` |
| `database` | `{ connections, config }` for a database per tenant (see below) |

Tenant ids are used in cache keys, paths and connection names. They may only contain letters, digits, `_`, `-` and `.`.

### Resolvers

| Resolver | Request | Key |
| --- | --- | --- |
| `domain` | `https://acme.com/posts` | `acme.com` (the whole host) |
| `subdomain` | `https://acme.example.com/posts` | `acme`. Only one level: `a.acme.example.com` doesn't match |
| `header` | `X-Tenant: acme` | `acme` |
| `path` | `/t/acme/posts` | `acme` |
| function | anything | what it returns |

The `path` resolver doesn't rewrite the URL: declare the routes with the segment, and it is also available as a parameter.

```ts
// route/tenant.ts
export default defineRoutes((r) => {
  r.group({ prefix: '/t/:tenant' }, (r) => {
    r.get('/posts', [PostController, 'index'])
  })
})
```

A key that `find()` doesn't know answers **404 Not Found**. So does a request without a key, unless `required: false`, the path is in `except`, or the host is in `centralDomains`.

### Installing the middleware

When `config/tenancy.ts` exists, the framework resolves the tenant before the global middleware. Everything after that, including your middleware, routes and controllers, runs in the tenant context. Static assets, signed storage links and the OpenAPI docs are served earlier and don't need a tenant. A 404 for an unknown tenant goes through your exception handler like any other error.

If only some routes need a tenant, set `global: false` and use the `tenancy` middleware on those routes:

```ts
import { tenancy } from '@hazejs/core'

r.group({ middleware: [tenancy] }, (r) => {
  // ...
})
```

## The current tenant

```ts
import { currentTenant, Tenancy, useTenant } from '@hazejs/core'

r.get('/me', (ctx) => {
  ctx.tenant // the tenant, or undefined
  useTenant() // the tenant; throws outside a tenant context
  currentTenant() // the tenant, or undefined
  Tenancy.key() // "acme"
  Tenancy.check() // true inside a tenant context
  Tenancy.current() // the tenant, or undefined (same as currentTenant())
})

await Tenancy.find('acme') // look a tenant up by key through find() (honors `remember`); undefined when unknown
```

Add your fields to the `Tenant` type with declaration merging:

```ts
// types.d.ts
declare module '@hazejs/core' {
  interface Tenant {
    slug: string
    name: string
    database: string
  }
}
```

### Jobs, commands and scripts

Outside requests, switch tenants with `Tenancy.run()`. Pass the tenant object or its key; an unknown key throws `TenantNotFoundException` (404).

```ts
await Tenancy.run('acme', async () => {
  await Post.create({ title: 'Hello' }) // acme's database / tenant_id
  await Cache.set('stats', stats) // tenant:acme:stats
})

for (const tenant of await Tenant.all())
  await Tenancy.run(tenant, () => runMigrations())

Tenancy.central(() => { /* no tenant, even inside a tenant context */ })
```

Queued jobs (including queued mail, listeners and search syncing) record the tenant's id when they are dispatched. The worker looks the tenant up with `find()` and runs the job inside `Tenancy.run()`. If the tenant no longer exists, the job fails without retrying. Jobs dispatched outside a tenant run without one.

## Isolation

### Cache

With tenancy, `Cache` keys get `tenant:<id>:` after the configured prefix. `Cache.flush()` inside a tenant only removes that tenant's keys. The same applies to stores used by sessions (`driver: 'cache'`), rate limiting and query caching. To isolate only some stores, or to change the prefix:

```ts
cache: { stores: ['redis'], prefix: id => `t:${id}:` }
```

### File storage

`Storage` paths get `tenants/<id>/`: `Storage.put('avatar.png', file)` writes `tenants/acme/avatar.png`. Public URLs and temporary URLs include the directory, so they also work outside the tenant context. `Storage.fake()` keeps working, and its assertions see the tenant's files inside `Tenancy.run()`. Options: `storage: { disks: ['s3'], prefix: id => `customers/${id}` }`.

### Sessions

Each tenant gets its own session cookie (`haze_session_acme`), and the signing / encryption key is derived per tenant. A session cookie copied from one tenant is rejected by the others, even when they share a domain (header or path resolvers).

## Database

### A database per tenant

Give the ORM a function that computes the tenant's connection from a template connection:

```ts
// config/database.ts
export default defineDatabaseConfig({
  default: 'central',
  connections: {
    central: { driver: 'postgres', url: env('DATABASE_URL') }, // tenants table, billing…
    tenant: { driver: 'postgres', url: env('TENANT_DATABASE_URL') }, // template
  },
})

// config/tenancy.ts
export default defineTenancyConfig({
  find: key => Tenant.where('slug', key).find(),
  database: {
    connections: ['tenant'], // default: the default connection
    config: (tenant, base) => ({ ...base, url: tenant.databaseUrl }),
  },
})
```

```ts
export class Post extends Model.define(posts) {
  static override connection = 'tenant'
}
```

Inside a tenant context, the connection named `tenant` resolves to `tenant@acme`, with the configuration returned by `config()`. Each tenant's connection is opened once and pooled until the application shuts down. `Db.connection('tenant')`, models, transactions (`transaction`, `startTrans`) and `runMigrations()` all follow it. Connections not listed (here `central`) never switch. Outside a tenant context, `tenant` uses the template configuration.

For SQLite, give each tenant a file: `config: (tenant, base) => ({ ...base, url: \`file:./data/tenants/${tenant.id}.db\` })`.

### One database with a tenant column

Mark the models that belong to a tenant:

```ts
export class Project extends Model.define(projects) {
  static override belongsToTenant = true // column tenantId, or the column name
}
```

Inside a tenant context:

- every query on the model, including relations, `find()`, counts and mass updates / deletes, adds `tenantId = <current tenant id>` (this filter does not count as a condition for the `{ all: true }` check: `Project.query().delete()` still throws);
- new models get `tenantId` filled in when it is empty.

```ts
await Tenancy.run('acme', async () => {
  await Project.create({ name: 'Rocket' }) // tenantId = 'acme'
  await Project.all() // only acme's projects
  await Project.withoutGlobalScope(['tenant']).count() // every tenant
})
```

The condition is the `tenant` global scope: `withoutGlobalScope(['tenant'])` or `withoutGlobalScope()` turns it off. Outside a tenant context (central code, admin commands) the model isn't filtered.

::: warning
The scope covers model queries only. Raw `Db.table()` queries and `Db.execute()` see every tenant's rows. Add the condition yourself there. `insert()` through the query builder does not fill the column either.
:::

## Testing

```ts
import { Tenancy } from '@hazejs/core'

it('lists the tenant\'s projects', async () => {
  const res = await app.request('/projects', { headers: { 'x-tenant': 'acme' } })
  expect(res.status).toBe(200)
})

it('creates a project for a tenant', async () => {
  await Tenancy.run({ id: 'acme' }, () => Project.create({ name: 'Rocket' }))
})
```

## Limitations

- Tenant connections stay open until the application shuts down. With thousands of tenants per process, close idle ones with `useDatabaseManager().close('tenant@acme')`.
- Scheduled tasks run without a tenant. Loop over the tenants with `Tenancy.run()` inside the task.
- The column scope applies to SQL models only, not to MongoDB models.
