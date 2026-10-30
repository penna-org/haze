---
'@hazejs/core': minor
'@hazejs/ai': minor
---

`app.introspect()` returns a serializable snapshot of the application: modules with what each one contributes (routes, providers, jobs, schedules, events, listeners, middleware), sub-apps, routes, global middleware, middleware aliases and groups with their owning module, providers, container bindings (`container.bindings()`), events with their listeners (`EventManager#events()`), queue jobs and scheduled tasks with their next run. Scheduled task runs are reported as `schedule` telemetry and shown in a new Schedule tab of the dev dashboard; request entries record the route name and module. When the dev dashboard is on, AI calls also record their messages, tools, output and tool calls (truncated); other telemetry consumers such as OpenTelemetry never receive them.
