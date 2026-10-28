---
'@hazejs/core': minor
'@hazejs/vite': minor
'@hazejs/cli': minor
---

OpenAPI 3.1 documents generated from routes and Standard Schema validators, served at `/openapi.json` with a Scalar or Swagger UI at `/docs` (off in production by default). Routes take `.doc({ summary, tags, response, status, hidden })`; `haze openapi` writes the document. Typegen now emits every named route's inputs and outputs, and `createClient()` from `@hazejs/core/client` gives frontends a typed HTTP client.
