# WebSocket Protocol

The session WebSocket is the public streaming interface for interactive turns.

Schema: [../schemas/websocket-event.schema.json](../schemas/websocket-event.schema.json).

## Connect

```text
GET /sessions/{sessionId}/ws
```

### Authentication

Browsers cannot set headers on a WebSocket, so pass the API key (or a session
token issued by the hosted console) as a WebSocket subprotocol token on the
upgrade request:

```text
GET /sessions/{sessionId}/ws
Sec-WebSocket-Protocol: parel-v1, token.{apiKey}
```

The server selects `parel-v1`. The `token.{apiKey}` subprotocol is used only for
authentication and must not be echoed back as the selected subprotocol. The key
needs the `write` or `admin` scope; `read` keys cannot open a session
WebSocket.

```js
const ws = new WebSocket("wss://api.parel.sh/sessions/ssn_.../ws", ["parel-v1", "token." + apiKey]);
ws.onopen = () => ws.send(JSON.stringify({ type: "message", content: "Hello" }));
ws.onmessage = (event) => console.log(JSON.parse(event.data));
```

Older clients may pass the same credential as a `token` query parameter:

```text
GET /sessions/{sessionId}/ws?token={apiKey}
```

The query parameter form remains a compatibility fallback. New clients should
use the subprotocol token so credentials do not appear in request URLs or access
logs.

## Client Events

Send a message (starts a turn, or queues while one is running):

```json
{
  "type": "message",
  "content": "Hello"
}
```

`content` is a string or a parts array with the same shape and media rules as
`POST /sessions/{sessionId}/messages` (see
[http-api.md](http-api.md#media-input)), bounded by the 1 MiB frame limit. An
optional `context` object is passed to plugins that consume invocation context,
as on the HTTP route. A `/name` string runs a slash command (see
[http-api.md](http-api.md#slash-commands)). Mid-turn delivery
(`injectInFlight`) and idempotency keys are HTTP-only; use
`POST /sessions/{sessionId}/messages` for them.

The server answers each `message` frame with one `message_ack`, or with an
`error` frame when the message is refused.

Resume after a (re)connect — request the current transcript so a client that
dropped mid-turn can recover output it missed:

```json
{ "type": "resume", "since_seq": 0 }
```

The server also pushes a `sync` event automatically immediately on connect, so an
explicit `resume` is only needed to re-request it.

Frames that are not valid JSON, or whose `type` is unknown, are ignored.

## Server Events

| Frame | Meaning |
| --- | --- |
| `sync` | Session state and transcript, on connect and on `resume`. |
| `message_ack` | Your `message` frame was taken. |
| `text` | Reply text as it streams. |
| `reasoning_start` / `reasoning_delta` / `reasoning_end` | Model reasoning as it streams. |
| `tool_call` / `tool_result` | A tool the agent called, and what came back. |
| `input_absorbed` | A message or channel event joined the running turn. |
| `execution_pause` | The session stopped at a pause policy (breakpoint). |
| `command_result` | A slash command finished. |
| `error` | Something failed; may carry a stable `code`. |
| `turn_end` | The turn is over. |

Clients must ignore frame types they do not know.

### `sync`

Emitted on connect (and in response to `resume`) so a reconnecting client can
re-render the conversation, including a turn that completed while it was
disconnected. `running` indicates whether a turn is currently in progress. Media
parts arrive without bytes (`dataOmitted: true`); read
`GET /sessions/{sessionId}/messages` for full data.

```json
{ "type": "sync", "state": { "id": "ssn_...", "status": "running" }, "messages": [], "eventSeq": 12, "running": false }
```

### `message_ack`

Acknowledges a client `message` frame. `status` is `accepted` (a turn started;
`turnId` is set), `queued` (it waits for the running turn), or `executed` (a
slash command ran without a turn; `result` is set). `command` names a recognized
slash command, and `warnings` carries non-fatal notes such as
`unknown_command` or `media_not_visible_to_model`.

```json
{ "type": "message_ack", "status": "accepted", "inputId": "inp_user_…", "turnId": "trn_..." }
```

### Text and reasoning streams

```json
{ "type": "text", "text": "Hello" }
```

```json
{ "type": "reasoning_start" }
{ "type": "reasoning_delta", "text": "I need to..." }
{ "type": "reasoning_end" }
```

Consecutive `text` or `reasoning_delta` chunks may be combined into one frame.
Clients append each frame's `text` to what they have; frame boundaries carry no
meaning.

### Tool call and result

```json
{ "type": "tool_call", "callId": "toolu_01…", "name": "bash", "arguments": { "command": "pwd" } }
{ "type": "tool_result", "callId": "toolu_01…", "name": "bash", "content": "/app", "isError": false, "durationMs": 412 }
```

`callId` pairs a result with its call. A `tool_result` may also carry `refs`
(references to content stored outside the transcript), `fullContentRef`,
`truncated`, and `originalByteLength` when the output was cut to
`runtime.toolResultMaxBytes`.

### `input_absorbed`

An input was delivered into the turn in flight: it became a transcript message
of this turn at the given step boundary. This happens for messages sent with
`injectInFlight: true` (and the deprecated `/steer` alias), and for
same-conversation channel events under a binding's `injectInFlight`.

```json
{ "type": "input_absorbed", "inputId": "inp_user_…", "messageId": "msg_inp_user_…", "turnId": "trn_...", "stepNumber": 3 }
```

### `execution_pause`

The session stopped at a pause policy. `pause` is the same object
`GET /execution/pauses/{pauseId}` returns. The turn then ends (`turn_end`
follows) and the session is `suspended` until the pause is resumed or
cancelled (see [http-api.md](http-api.md#execution-pauses)).

```json
{
  "type": "execution_pause",
  "pause": {
    "id": "exp_...",
    "sessionId": "ssn_...",
    "policyId": "epp_...",
    "snapshotId": "exs_...",
    "anchor": "before_tool",
    "status": "paused",
    "payload": { "toolName": "bash" },
    "resumePayload": {},
    "createdAt": "..."
  }
}
```

### `command_result`

Slash command outcome (see [http-api.md](http-api.md#slash-commands)). A command
that ran inline is acknowledged with `message_ack.status: "executed"` and no
`turn_end` follows; one that waited for a running turn reports later. Either way
the outcome arrives as one `command_result`:

```json
{ "type": "message_ack", "status": "executed", "inputId": "inp_user_…", "command": { "name": "compact", "args": "" }, "result": { "ok": true, "reply": "Compacted 12 message(s) …", "durationMs": 1830 } }
{ "type": "command_result", "inputId": "inp_user_…", "name": "compact", "args": "", "ok": true, "reply": "Compacted 12 message(s) …", "durationMs": 1830 }
```

A failed command carries `ok: false`, `error` and `code: "command_failed"`. A
command that expanded into a prompt carries the `turnId` it opened. A
`message_ack` for an unrecognized `/name` carries a `warnings` entry with
`code: "unknown_command"`; the text was delivered as an ordinary message.

### `error`

```json
{ "type": "error", "error": "Model provider rate limit", "code": "rate_limited" }
```

`code` is optional and uses the stable codes in
[http-api.md](http-api.md#error-codes). An `error` sent in reply to a `message`
frame means the message was refused (for example `session_terminated`,
`billing_insufficient`, `media_invalid`). An `error` during a turn means the
step or turn failed; `turn_end` still follows.

### `turn_end`

```json
{
  "type": "turn_end",
  "state": {
    "id": "ssn_...",
    "agentId": "agt_...",
    "orgId": "org_...",
    "status": "ready",
    "turnCount": 1,
    "stepCount": 1,
    "totalTokens": 123,
    "totalCostUsd": 0.001,
    "createdAt": 1760000000000,
    "updatedAt": 1760000001000
  }
}
```

`turn_end` is also sent when a turn is refused at admission (for example a plan
limit), right after the `error` frame, and when the session is terminated.

## Ordering

For one client message, servers emit zero or more stream events followed by exactly one terminal event:

- `turn_end` for a completed or finalized turn.
- `error` may appear before `turn_end` when a turn fails but the session can still be finalized.
- `execution_pause` may appear before `turn_end` when the turn stopped at a pause policy.
- `input_absorbed` appears between steps of the running turn; it is not terminal.
- `message_ack` with `status: "executed"` for a slash command that ran without a turn (its `command_result` precedes it); no `turn_end` follows.

Clients should keep reading until `turn_end` before considering the turn complete.

## Compatibility Notes

Older clients may treat unknown event types as non-fatal and ignore them. New event types must not change the meaning of the existing terminal `turn_end` event.
