---
'@hazejs/core': minor
---

Outgoing HTTP client `Http`, built on `fetch` with no dependencies (Node, Bun, Deno, Workers): an immutable request builder with base URLs, headers, bearer / basic auth, query and URL parameters, JSON / form / multipart bodies, per-attempt timeouts, retries with backoff and `retry-after`, `HttpRequestException` / `ConnectionException` / `TimeoutException`, middleware, `pool()` with a concurrency limit, streaming and server-sent events, named clients in `config/http.ts` (`defineHttpConfig`) and `toFetch()` for third-party SDKs. Requests are traced with OpenTelemetry (`traceparent`), recorded as `http` telemetry events with credentials masked, and shown in the dev dashboard. For tests, `Http.fake()` with URL patterns, callbacks and sequences, `Http.preventStrayRequests()` and `assertSent` / `assertNotSent` / `assertSentCount` / `assertNothingSent` / `recorded()`, scoped to the application like the other fakes.
