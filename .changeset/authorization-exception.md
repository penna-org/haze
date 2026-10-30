---
'@hazejs/core': patch
---

Gate denials for signed-in users throw `AuthorizationException`, a `ForbiddenException` subclass carrying `abilities` (the denied ability, or every candidate for `authorizeAny`) and `reason` (the `deny()` message), so exception handlers can name the missing permission or localize the message. Status, code and default message are unchanged.

`ctx.route` exposes the matched route — `method`, the `path` pattern, `name` and the `meta` set with `.meta()` — so route middleware such as audit logs can read what the route declared.

Middleware passed as a function or class is listed as `name()` (`route:list`, `RouteRecord.middleware`), so a function that happens to be called `guest` or `auth` is no longer mistaken for that alias — previously OpenAPI added a `403` / `401` response for it.

`app.onBooted(callback)` runs a callback after every provider has booted (immediately once the app is booted), so module providers — which boot before the app's — can wait for resources an app provider prepares, such as an open database connection.
