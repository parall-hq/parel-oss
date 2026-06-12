# PAREL Schemas

Language-neutral JSON Schemas for public PAREL SDKs, plugins, and clients.

These schemas are the machine-readable contract for data that crosses package or language boundaries.

| Schema | Purpose |
| --- | --- |
| [agent-config.schema.json](agent-config.schema.json) | Public `agent.yaml` shape. |
| [message.schema.json](message.schema.json) | Provider-neutral transcript messages and message parts. |
| [transcript.schema.json](transcript.schema.json) | Ordered session transcript envelope. |
| [websocket-event.schema.json](websocket-event.schema.json) | Session WebSocket client and server events. |
| [plugin-manifest.schema.json](plugin-manifest.schema.json) | Runtime plugin metadata. |
| [api-error.schema.json](api-error.schema.json) | Public API error envelope. |

Protocol semantics live in [../protocol](../protocol).
