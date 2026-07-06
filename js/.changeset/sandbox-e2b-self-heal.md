---
"@parel/sandbox-e2b": minor
---

Sandbox tools self-heal instead of failing the whole turn. Every tool and
capability call now lazily (re)establishes the sandbox when the in-memory
handle is missing — reconnect the stored sandbox id first, create fresh as a
fallback — with a single-flight guard so concurrent calls share one recovery.
Previously a missed lifecycle hook left every sandbox tool of the turn failing
instantly with a generic "E2B sandbox not available".

Failures now name their real cause: a missing `apiKey` throws loudly at
creation time (it used to silently skip creation and break every tool), and
creation failures carry the underlying E2B error.

Safer sandbox swaps: reconnect retries once before giving up, so a transient
network blip no longer silently replaces a persistent sandbox (losing its
filesystem); when the swap does happen it is logged as a filesystem reset and
the unreachable sandbox is killed best-effort so its paused snapshot stops
accruing storage. Session end now also reaps a stored-but-unloaded sandbox id.
