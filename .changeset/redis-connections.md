---
'@hazejs/core': minor
'@hazejs/socket.io': minor
'@hazejs/microservices': minor
'create-hazejs': minor
---

Unified Redis connections. New `config/redis.ts` (`defineRedisConfig`) declares named connections: a URL or host / port / password / db / TLS, Cluster, Sentinel or a custom client factory, each with an optional `keyPrefix`. Without the file there is one implicit `default` connection reading `REDIS_URL`. The cache `redis` store, the BullMQ queue driver, WebSocket broadcasting, the broadcasting bus, the Socket.IO Redis adapter and the microservices Redis transport accept `connection: '<name>'` (default: the `default` connection), so a single `REDIS_URL` configures all of them; the inline `url` / `options` / `client` forms keep working and take precedence. A shared `RedisManager` opens one command connection per name (kept across hot reloads, closed on shutdown) and dedicated connections for subscribers and blocking commands; BullMQ receives the settings with `keyPrefix` removed and `maxRetriesPerRequest: null`. New `Redis` facade and `useRedis()`, `redisCheck(name)` pings a connection (cache store names still work), and connection names are typed from the generated config. ioredis is loaded through one helper with a single install hint. New projects include `config/redis.ts`, and their cache, queue, WebSocket and Socket.IO configs reference `connection: 'default'`.
