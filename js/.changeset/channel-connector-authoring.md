---
"@parel/plugin-sdk": minor
---

Add channel connector authoring surface: `ConnectorContext.store` (a durable per-connection key-value store the platform persists across reconnect/eviction — use it for protocol state such as a resume cursor) and the `defineChannelConnector` identity helper for type-checked connector authoring. A connector package's default export is the `ChannelConnector`; declare `type: "channel"` plus `channel.connectionTypes` / `channel.sources` in `parel.plugin.json`.
