---
'@hazejs/core': minor
---

`schedule.runInServer` and `queue.runInServer` run the scheduler and a queue worker inside the HTTP server process for development and single-instance deployments. They start when the server starts listening (`haze dev`, `haze start`, the node and docker builds), stop after running jobs finish when the application is disposed, and never start in tests or console commands. `queue.runInServer` accepts `true` or `{ connection, queues, concurrency }`.
