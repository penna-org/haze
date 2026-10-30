---
'@hazejs/devtools': minor
---

DevTools panels for module linkage, requests, AI and tasks, plus an MCP endpoint for coding agents:

- **Graph**: modules, sub-apps, events and jobs as an interactive graph. Declared links (who defines an event or job, who listens, scheduled jobs, middleware used across modules, sub-app mounts) and runtime links with counts (events emitted and jobs dispatched while handling requests and jobs).
- **Requests**: recent requests with a waterfall timeline of their queries, cache calls, events, jobs (including queued work they caused), mail, logs, exceptions, AI and outgoing HTTP calls, and repeated-query (N+1) warnings.
- **AI**: calls, tokens and latency per model, the messages, output and tool calls of each call, and a playground that runs a prompt against the app's configured models.
- **Tasks**: scheduled tasks with their next and last run and a "Run now" button, queue counts, and per-job dispatch / success / failure counts.
- **Internals** (providers, container bindings, events and listeners, jobs, middleware) and **API Docs** (the app's `/docs` page).
- **MCP** at `/__devtools/__mcp` (loopback only, clients send their local `Origin`): tools to inspect the app, search routes, read the module graph, list requests and their timelines, read AI calls and the OpenAPI document, and run a scheduled task. Turn it off with `devtools: { mcp: false }`.
