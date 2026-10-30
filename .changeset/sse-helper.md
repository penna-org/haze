---
'@hazejs/core': minor
---

`ctx.sse(source, options?)` returns a Server-Sent Events response. The source is an async iterable (one event per item, closes when it ends) or a function that keeps the stream open until `stream.close()`. It sends a `: ping` heartbeat every 15 seconds, closes and runs `stream.onClose()` hooks when the client disconnects, logs and closes on source errors, and sets `cache-control: no-cache, no-transform` and `x-accel-buffering: no`. `eventStream()` and `encodeSseEvent()` are exported for use outside a request. Broadcasting's `/broadcasting/sse` and the dev dashboard stream now use it, and `cacheResponse` no longer buffers `text/event-stream` responses.
