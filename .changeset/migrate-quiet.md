---
'@hazejs/vite': patch
---

The production `migrate.mjs` no longer prints a `skipped (no-migrations)` line, labelled with the default connection, for every local module that has no migrations.
