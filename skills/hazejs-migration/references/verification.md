# Verifying a migration

A migration is done when the old behaviour is proven, not when it compiles. Work through every step and report the numbers.

## 1. Test suite as the oracle

- Record the baseline on the old framework first: files, passed, skipped, duration.
- After the swap, run the same suite. Target: identical pass/skip counts.
- Allowed test edits are **equivalence-only**, each explained in the change description:
  - attribute order (cookies), header casing, trailing slashes in documented paths;
  - richer payloads where tests used exact equality (`toEqual` → `toMatchObject`), e.g. `/health`;
  - synchronous → asynchronous helpers (`app.swagger()` → `await app.swagger()`);
  - browser-realistic requests (SPA fallback needs `Accept: text/html`).
- Never weaken an assertion about status codes, error codes, permissions or data.
- Keep architecture tests meaningful: replace "services must not import fastify" with "services must not import `@hazejs/core` / `h3`".

## 2. Static checks

```bash
tsc --noEmit -p tsconfig.json
<lint/format command of the project>
```

Remove the old framework's packages from `package.json` and the workspace catalog, reinstall, and confirm nothing imports them:

```bash
grep -rln "fastify\|awilix\|close-with-grace\|pino-pretty" --exclude-dir=node_modules --exclude-dir=dist .
```

## 3. Build and runtime install

- Build the production bundle; list remaining bare imports to know what the runtime stage must install:
  ```bash
  grep -ho 'from "[^".][^"]*"' dist/*.mjs | sort -u
  grep -ho 'import("[^".][^"]*")' dist/*.mjs | sort -u   # optional peers, only loaded when configured
  ```
- Simulate the Docker runtime stage: generate the runtime `package.json`, install with `npm install --omit=dev` into an empty directory, copy `dist` and migrations, start with production env. Vendored `@hazejs/*` tarballs must be bundled (their own deps get inlined when not declared by the app).

## 4. Real server smoke test

Start the built server (an in-memory database such as PGlite is ideal) and check:

| Check | How |
| --- | --- |
| health | `curl /health` → 200 and checks ok |
| login + authenticated read | token, then a list endpoint |
| error formats | 401 without token, 404 unknown route, 400 validation (field paths), invalid JSON, `Accept-Language` localisation |
| headers | security headers, request id, CORS when configured |
| docs | `/docs` page and the JSON document (paths count, vendor extensions) |
| streaming | `curl -N` an SSE endpoint; headers present, events arrive incrementally |
| sockets | connect with the real client (websocket and polling), rejected handshake with a bad token |
| uploads / downloads | multipart upload, Range request (206), ETag (304) |
| shutdown | `kill -TERM` → exits promptly, no errors in the log |

## 5. Browser walkthrough

Serve the real frontend (single-process mode with the built frontend is the quickest), log in with seeded test accounts on localhost, open the main pages, perform one real write flow (e.g. approve a request), then check the console, the network panel (no 4xx/5xx surprises) and the audit log written by the backend.

## 6. Performance

Run old and new side by side on the same machine, **interleaved** (A, B, A, B) — single runs are noisy. Measure framework-only paths (404, 400) and realistic paths (auth + DB + encoding). Small benchmark script:

```js
// node bench.mjs <base> <seconds> <concurrency>
const [base, seconds = '8', concurrency = '32'] = process.argv.slice(2)
const { token } = await (await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'admin123' }) })).json()
const targets = {
  'auth+db': () => fetch(`${base}/api/users?page=1&pageSize=10`, { headers: { authorization: `Bearer ${token}` } }),
  '404': () => fetch(`${base}/api/nope`),
}
for (const [name, call] of Object.entries(targets)) {
  const latencies = []
  let errors = 0
  const end = Date.now() + Number(seconds) * 1000
  await Promise.all(Array.from({ length: Number(concurrency) }, async () => {
    while (Date.now() < end) {
      const start = performance.now()
      try { const res = await call(); await res.arrayBuffer(); if (res.status >= 500) errors++ } catch { errors++ }
      latencies.push(performance.now() - start)
    }
  }))
  latencies.sort((a, b) => a - b)
  console.log(name, Math.round(latencies.length / Number(seconds)), 'req/s', 'p99', latencies[Math.floor(latencies.length * 0.99)].toFixed(1), 'ms', 'errors', errors)
}
```

If the new version is clearly slower, profile before guessing: `node --cpu-prof --cpu-prof-dir=prof dist/main.mjs`, load it, stop with SIGINT, then aggregate self time by package (hazejs + h3 + srvx vs database vs app code).

Reference result (Fastify → hazejs, PGlite, 32 concurrent): auth + DB endpoints within ±8 %, framework-only paths about 10 % slower, zero errors; hazejs + h3 + srvx ≈ 9 % of CPU.

## 7. Report

State: baseline vs final test counts, test edits and why, dependencies removed, bundle/runtime result, smoke results, benchmark table, framework gaps found (fixed upstream vs worked around), and what is not verified (e.g. Docker image not built, real PostgreSQL not exercised).
