---
'@hazejs/core': minor
'@hazejs/orm': minor
'@hazejs/ai': minor
'@hazejs/vite': minor
---

Observability: health checks at `/health` (`/health/live`, `/health/ready`, built-in cache / database / Redis / storage / queue checks), optional OpenTelemetry traces and metrics (HTTP, queue jobs with trace propagation, SQL, mail, cache and `gen_ai.*` spans), log channels (stack, JSON, daily files, batched HTTP, custom), and a development dashboard at `/__haze` for requests, queries, jobs, mail, events, cache, logs and AI calls, plus a queue dashboard with retry and forget.
