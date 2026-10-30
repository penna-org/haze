---
'@hazejs/core': patch
---

`app.serve()` no longer hangs on `SIGTERM` / `SIGINT` while WebSockets, SSE streams or keep-alive connections are open: after waiting for in-flight requests up to `app.shutdownTimeout` (default 10 seconds) it closes the remaining connections, disposes the application and exits. Previously a connected browser (for example a Socket.IO client) kept the process alive until the orchestrator killed it.
