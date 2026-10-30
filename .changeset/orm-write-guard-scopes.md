---
"@hazejs/orm": patch
---

Fix the guard against whole-table writes on model queries: `update()` and `delete()` (including `forceDelete()` and `restore()`) now check only your own conditions (`where()`, local scopes, primary keys passed to `delete(ids)`). Previously the filters a model adds automatically — the soft-delete `deletedAt IS NULL`, the `belongsToTenant` column and global scopes — counted as a condition, so `Post.query().delete()` or `Post.query().update({ ... })` on such models silently affected every row (every row of the current tenant) without `{ all: true }`. The same applies to MongoDB models with soft deletes. **Behaviour change:** these calls now throw `DatabaseError("Refusing to … without conditions. Pass { all: true } to confirm.")`; add a `where()` or pass `{ all: true }` (for example `Post.onlyTrashed().forceDelete({ all: true })`). The executed statement still includes the scope filters.
