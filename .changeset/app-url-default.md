---
'@hazejs/core': patch
---

`app.url` now defaults to the `APP_URL` environment variable, so absolute links such as `Storage.temporaryUrl()` on local disks work without adding `url` to `config/app.ts`. An explicit `url` in `config/app.ts` still takes precedence.
