---
"@parel/core": minor
"@parel/plugin-sdk": minor
---

Tools can now be cancelled when the turn that issued them is stopped (`protocol/execution-control.md`):

- `ToolHandlerContext.signal` aborts on stop in the isolate that observed it.
- `ToolRegistrationOptions.abort` is an out-of-band hook the host calls with `{ toolCallId, sessionId, turnId }`. It may run in another isolate, more than once, and before the handler has started, so implementations must be stateless and idempotent and must make a later start of the same call a no-op.

Additive: tools without either keep running to their own completion.
