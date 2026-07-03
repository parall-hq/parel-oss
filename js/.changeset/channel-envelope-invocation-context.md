---
"@parel/core": minor
---

`ChannelEnvelope` gains an optional `context` field: per-turn invocation context a channel connector attaches to its emitted envelope, snapshotted at turn start and exposed to consume-gated plugins (e.g. flattened into sandbox per-exec env).
