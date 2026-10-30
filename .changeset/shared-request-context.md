---
'@hazejs/core': patch
---

The request context and the telemetry scope now live on `globalThis`, shared by every copy of `@hazejs/core` in the process. During development the app code is re-evaluated on each hot reload while the dev dashboard's store survives it, so events, jobs and queries recorded after a reload (or with core linked into a workspace) lost their request ID and no longer showed up under their request.
