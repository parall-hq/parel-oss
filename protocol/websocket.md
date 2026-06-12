# WebSocket Protocol

The session WebSocket is the public streaming interface for interactive turns.

Schema: [../schemas/websocket-event.schema.json](../schemas/websocket-event.schema.json).

## Connect

```text
GET /sessions/{sessionId}/ws
```

### Authentication

Pass the API key (or a session token issued by the hosted console) as a
WebSocket subprotocol token on the upgrade request:

```text
GET /sessions/{sessionId}/ws
Sec-WebSocket-Protocol: parel-v1, token.{apiKey}
```

The server selects `parel-v1`. The `token.{apiKey}` subprotocol is used only for
authentication and must not be echoed back as the selected subprotocol.

Older clients may pass the same credential as a `token` query parameter:

```text
GET /sessions/{sessionId}/ws?token={apiKey}
```

The query parameter form remains a compatibility fallback. New clients should
use the subprotocol token so credentials do not appear in request URLs or access
logs.

## Client Events

Start a turn:

```json
{
  "type": "message",
  "content": "Hello"
}
```

Resume after a (re)connect — request the current transcript so a client that
dropped mid-turn can recover output it missed:

```json
{ "type": "resume", "since_seq": 0 }
```

The server also pushes a `sync` event automatically immediately on connect, so an
explicit `resume` is only needed to re-request it.

## Server Events

Transcript sync — emitted on connect (and in response to `resume`) so a
reconnecting client can re-render the conversation, including a turn that
completed while it was disconnected. `running` indicates whether a turn is
currently in progress:

```json
{ "type": "sync", "state": { "id": "ssn_...", "status": "running" }, "messages": [], "eventSeq": 12, "running": false }
```

Text stream:

```json
{ "type": "text", "text": "Hello" }
```

Reasoning stream:

```json
{ "type": "reasoning_start" }
{ "type": "reasoning_delta", "text": "I need to..." }
{ "type": "reasoning_end" }
```

Tool call and result:

```json
{ "type": "tool_call", "name": "bash", "arguments": { "command": "pwd" } }
{ "type": "tool_result", "name": "bash", "content": "/app", "isError": false }
```

Turn completion:

```json
{
  "type": "turn_end",
  "state": {
    "id": "ssn_...",
    "agentId": "agt_...",
    "orgId": "org_...",
    "status": "running",
    "turnCount": 1,
    "stepCount": 1,
    "totalTokens": 123,
    "totalCostUsd": 0.001,
    "createdAt": 1760000000000,
    "updatedAt": 1760000001000
  }
}
```

Error:

```json
{ "type": "error", "error": "Container error: ..." }
```

## Ordering

For one client message, servers emit zero or more stream events followed by exactly one terminal event:

- `turn_end` for a completed or finalized turn.
- `error` may appear before `turn_end` when a turn fails but the session can still be finalized.

Clients should keep reading until `turn_end` before considering the turn complete.

## Compatibility Notes

Older clients may treat unknown event types as non-fatal and ignore them. New event types must not change the meaning of the existing terminal `turn_end` event.
