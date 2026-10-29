---
'@hazejs/core': minor
'@hazejs/orm': minor
'@hazejs/vite': minor
'@hazejs/cli': minor
'create-hazejs': minor
---

Model factories and read/write splitting. `defineFactory(Model, ({ faker, sequence, n, index }) => attributes)` in `database/factories` builds typed models with `make()`, `create()`, `raw()`, `count()`, `createMany()` / `makeMany()`, named and inline states, `sequence()`, `afterMake` / `afterCreate`, factory and function attribute values, and relations read from the model: `for()` (belongsTo / morphTo), `has()` (hasMany / hasOne / morphMany / morphOne / belongsToMany) and `hasAttached()` with pivot data; multi-model creates run in a transaction. Fake data comes from `@faker-js/faker`, an optional peer loaded on first use, with the locale from `database.factories.locale` or `.locale()`. SQL connections accept `write`, `read` (one or more replicas) and `sticky`: reads go to a random replica, while writes, transactions, `lock()`, `useWriter()`, `Model.onWriter()`, `Db.useWriter(fn)`, raw `Db.execute()` / `Db.drizzle()` and `refresh()` use the primary; with `sticky`, reads after a write in the same request (or `Db.withinScope()`) stay on the primary. Works with per-tenant connections; replica queries report `replica: true` to the dev dashboard and `db.replica` on OpenTelemetry spans. `pool` also accepts `{ max, idleTimeout, connectTimeout }`. Core exports `getRequestStore()`. New `haze make:factory` (with `--module`), and the api / vue / react templates ship a `UserFactory` used by their tests.
