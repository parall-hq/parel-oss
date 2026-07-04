---
"@parel/plugin-sdk": minor
---

Add the `resolvePause` connector effect: the human-in-the-loop decision backflow for the `execution_paused` agent event. A connector returns `{ type: "resolvePause", pauseId, approve, comment? }` from any hook (typically `onMessage`/`onWebhook` after an external approval); the platform executes it with host-side authorization — the connector never holds platform credentials. Ships together with the platform's `execution_paused` emission and step-trace (`observe: [steps]`) events.
