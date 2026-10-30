---
'@hazejs/cli': patch
---

`haze route:list --json` writes only the JSON document to stdout; logs printed while the application boots (and hot-update notices) go to stderr, so the output can be redirected to a file or piped to `jq`.
