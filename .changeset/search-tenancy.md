---
'@hazejs/search': minor
'@hazejs/core': minor
'@hazejs/orm': minor
'@hazejs/cli': minor
---

New optional package `@hazejs/search`: full-text search for models on the database (MySQL `FULLTEXT`, PostgreSQL `tsvector`, SQLite FTS5, `LIKE`), Meilisearch, Typesense and Elasticsearch / OpenSearch over `fetch`, with index syncing on model events (optionally queued), `haze search:import` / `search:flush` / `search:sync-settings` and `Search.fake()`. Multi-tenancy in core: tenants resolved by domain, subdomain, header, path or a custom resolver, `useTenant()` / `ctx.tenant` / `Tenancy.run()`, per-tenant cache prefixes, storage directories, sessions and queued jobs; the ORM adds a database per tenant and `static belongsToTenant` for a shared database with a tenant column, plus `observeModel()` for model event observers.
