---
"@parel/plugin-sdk": minor
---

Add `ConnectRequest.liveness`: a per-connection liveness contract a channel
connector's `connect()` can declare. `staleAfterMs` sets the silence window the
platform tolerates before treating the socket as dead and re-dialing (clamped
to the platform range); `ping` asks the host to send a literal keepalive frame
on an interval without waking the connector. Undeclared connectors keep the
platform's conservative default behavior.
