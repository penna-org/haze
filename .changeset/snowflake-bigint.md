---
'@hazejs/orm': minor
'@hazejs/core': minor
---

Snowflake ids and lossless 64-bit integers. `@hazejs/orm/columns` adds `pgSnowflake()`, `mysqlSnowflake()` and `sqliteSnowflake()` columns that generate ids on insert and expose them as decimal strings, plus a `Snowflake` generator compatible with MyBatis-Plus / Hutool (same bit layout and epoch), configured with `snowflake` in `config/database.ts` or the `SNOWFLAKE_WORKER_ID` / `SNOWFLAKE_DATACENTER_ID` environment variables. MySQL connections now enable `supportBigNumbers`, and SQLite / Turso return integers beyond 2^53 as `BigInt` instead of throwing. `BigInt` values are serialized as strings in responses, model `toJSON()`, logs, cache, queue payloads, sessions and WebSocket messages (`jsonReplacer` / `toJsonSafe` in `@hazejs/core`).
