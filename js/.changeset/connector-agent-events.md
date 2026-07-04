---
"@parel/plugin-sdk": minor
---

Add the `onAgentEvent` connector hook with the `AgentEvent` union and `AgentEventEffect` return type: opt-in, best-effort agent execution events (turn lifecycle now; step-trace and execution-pause events contract-reserved) pushed to channel connectors for turns their envelopes triggered. `AgentEventEffect` excludes `emitEvent` at the type level (self-trigger guard); the platform also drops any `emitEvent` arriving at runtime.
