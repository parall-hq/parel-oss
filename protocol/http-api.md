# HTTP API Protocol

The public HTTP API is JSON over HTTPS. The hosted API is
`https://api.parel.sh`; the guided reference is <https://parel.sh/docs/api>. A
deploy may also send its raw `agent.yaml`.

Every request except `GET /health` and channel webhook ingress carries a
workspace API key:

```http
Authorization: Bearer pk_...
```

Create keys in the console under
[Settings → API keys](https://parel.sh/console/settings/api-keys), or with
`POST /api-keys`.

In the paths below, `{name}` is an agent's name and `{idOrName}` accepts the
agent's id or its name.

## API Key Scopes

Every API key has one scope. Keys created without `scopes` get `write`.

| Scope | Allows |
| --- | --- |
| `read` | `GET` requests only: it can read everything and change nothing. It cannot open a session WebSocket. |
| `write` | Everything except changing API keys, model provider keys, secrets, and billing: deploy agents, start sessions, send messages. A deploy may still carry secrets for its own agent. |
| `admin` | Everything, including writes to `/api-keys`, `/provider-keys`, `/secrets`, and `/billing`. |

A missing, invalid, expired, or revoked key gets `401`. A key whose scope does
not allow the request gets `403`.

## Errors

Error responses use [../schemas/api-error.schema.json](../schemas/api-error.schema.json):
a JSON object carrying a human-readable `error` string plus optional fields.

| Field | Type | Notes |
| --- | --- | --- |
| `error` | string | Human-readable message. Always present. |
| `code` | string, optional | Stable machine-readable error code — lowercase snake_case (`^[a-z][a-z0-9_]*$`). Additive: match on it for programmatic handling, but always tolerate its absence and fall back to `error`. Treat an unknown code as a generic failure. |
| `details` | any, optional | Structured context, e.g. config-validation details. |
| `request_id` | string, optional | Correlates the response with server logs. |

```http
HTTP/1.1 404
```

```json
{
  "error": "Agent not found",
  "code": "not_found"
}
```

### HTTP Status

| Status | Meaning |
| --- | --- |
| `400` | The request is malformed or a value is invalid. |
| `401` | Missing, invalid, expired, or revoked API key. |
| `402` | The plan does not allow this (`plan_limit`). |
| `403` | The key's scope does not allow this request. |
| `404` | Not found, or not in this workspace. |
| `409` | Conflicts with the current state: a session that cannot take a turn, a name already taken, an instance still in use. |
| `413` | The message or upload is too large. |
| `429` | Too many requests, running sessions, or waiting inputs; retry later. |
| `500` | Server failure. |
| `501` | Not available on this server. |
| `502` | A channel connector could not connect. |
| `503` | The server is not set up for this request. |

### Error Codes

A failed turn carries the same codes in its turn receipt
(`GET /turns/{turnId}`), in the `turn:error` event, and in the WebSocket
`error` frame. "Deploy check" means the code appears in deploy and
`POST /agents/validate` results; "warning" means it appears in a `warnings`
entry and does not fail the request.

| Code | Where | Meaning |
| --- | --- | --- |
| `invalid_request` | 400 | A field is missing or has a bad value. |
| `unauthorized` | 401 | Reserved. Auth failures today return only the message; check the status. |
| `forbidden` | 403 | The key's scope is too low. |
| `not_found` | 404 | No such resource in this workspace. |
| `rate_limited` | 429 · turn | Too many requests, running sessions, or waiting inputs. As a turn error: the model provider rate-limited the call. |
| `internal` | 500, 503 | Server failure. |
| `config_invalid` | 400 · deploy check | The agent config does not parse or validate. |
| `secret_unresolved` | 400 · deploy check | The config references a secret that is not set. |
| `secret_literal` | 400 · deploy check | A plugin's secret field holds a plain value; use a `${NAME}` reference. |
| `artifact_invalid` | 400 · deploy check | A plugin artifact is wrong, or a local plugin was deployed without one. |
| `plugin_freeze_failed` | 400 · deploy check | A plugin could not be resolved or packed. |
| `agent_name_exists` | deploy check · warning | An agent with this name exists; deploying adds a version to it. |
| `var_deferred` | deploy check · warning | The config uses `${var:NAME}`; every instance has to supply the value. |
| `model_unsupported` | deploy check · turn | Unknown model provider, or model settings it does not accept. |
| `model_var_unresolved` | deploy check · turn | The `model` block uses an instance var that is not set. |
| `model_var_invalid` | deploy check · turn | An instance var in the `model` block has a bad value. |
| `runtime_var_unresolved` | deploy check · turn | The `runtime` block uses an instance var that is not set. |
| `runtime_var_invalid` | deploy check · turn | An instance var in the `runtime` block has a bad value. |
| `plugin_var_unresolved` | deploy check · warning | A plugin's config uses a var that has no value. |
| `provider_auth` | turn · deploy check | No key for the model provider, or the provider refused it. |
| `model_error` | turn | The model call failed. |
| `model_timeout` | turn | The model call took too long. |
| `model_output_limit` | turn | The reply hit the output token limit. |
| `model_filtered` | turn | The provider's content filter stopped the reply. |
| `model_incomplete` | turn | The reply ended without a normal end, or with unfinished tool arguments. |
| `context_window_exceeded` | turn | The conversation no longer fits in the model's context window. |
| `billing_insufficient` | 409 | The Free plan's steps are used up, or the spend cap is reached. |
| `billing_suspended` | 409 | The workspace is suspended. |
| `plan_limit` | 402 | Over the plan's limit of always-on connections. |
| `budget_exceeded` | 409 | The instance's spending budget (`runtime.instanceBudgetUsd`) is used up. |
| `turn_limit` | 409 | The session reached `runtime.maxTurns`. |
| `session_terminated` | 409 | The session has ended. |
| `instance_not_found` | 404 | `requireExistingInstance` was set and the instance does not exist. |
| `instance_generation_mismatch` | 409 | `expectedInstanceGeneration` does not match: the instance was reset. |
| `media_invalid` | 400 | A media part is malformed or its type is not allowed. |
| `media_too_large` | 413 | Media over the size or count limits. |
| `command_failed` | command result | A slash command failed. |
| `idempotent_replay` | warning | This idempotency key was already handled; the response is the original result. |
| `missing_idempotency_key` | warning | No idempotency key was sent, so a retry would run twice. |
| `media_not_visible_to_model` | warning | The current model cannot see this media; it gets a text note in its place. |
| `unknown_command` | warning | Not a known slash command; it was sent as a normal message. |

Consumers must tolerate codes not listed here.

A partial model response is not a successful turn. A terminal turn receipt with
`status: "error"` never represents successful completion. Rate-limit receipts
may carry `completionKind: "retryable"` and a `retryAfterMs` hint in
milliseconds; this is a provider delay, not a guarantee that replaying an entire
turn is safe. Earlier hooks or tools may have performed external writes. Model
retries stay within the current call and occur only before output, sharing one
total budget.

`GET /sessions/{sessionId}/steps` includes durable failure evidence as
`{ "type": "turn_failed", "seq": number, "turnId": string, "reason": string }`,
including failures after visible progress. Clients should deduplicate by the
normal step cursor and tolerate unknown step types.

Session termination cancels active model requests and prevents further requests
or tool dispatch after cancellation is observed. It does not undo an external
operation that has already started.

## Rate Limits

Requests are counted per minute in a fixed window: 6000 per IP and 1200 per API
key. Going over either returns `429` with code `rate_limited`. Separately, while
25 of a workspace's sessions are running, starting another session returns
`429`.

| Header | Meaning |
| --- | --- |
| `X-RateLimit-Limit` | The limit that applies: 1200 with an API key, 6000 per IP without. |
| `X-RateLimit-Remaining` | Requests left in this window (the lower of the two counters). |
| `X-RateLimit-Reset` | When the window resets, in Unix seconds. |

## Health

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| `GET` | `/health` | No | Returns `{ "status": "ok" }`. |

## Agents

An agent is addressed by its **name**, unique in the workspace. Each deploy
uploads an immutable **version** (`v1`, `v2`, …); a **deployment** decides which
version is live.

| Method | Path | Body | Description |
| --- | --- | --- | --- |
| `POST` | `/agents/{name}/versions` | raw `agent.yaml`, or JSON (below) | Deploy: upload the config as a new version and make it live. The first deploy creates the agent (`201`); later deploys answer `200`. `?activate=false` (or `"activate": false`) uploads without making it live. |
| `POST` | `/agents/validate` | same as a deploy | Check a deploy without doing it. Writes nothing; always `200` with a verdict (below). |
| `GET` | `/agents` | none | List agents with their model, session counts, and total cost. |
| `GET` | `/agents/{idOrName}` | none | Get one agent with its live config and default vars (`vars_json`). |
| `PATCH` | `/agents/{idOrName}` | `{ "vars": { "NAME": "value" } }` | Replace the agent-level default vars. Each instance can override them per name; running sessions pick up the change at their next turn. Returns the agent as `GET` does. |
| `DELETE` | `/agents/{idOrName}` | none | Delete an agent with its versions, agent-scoped secrets, channel bindings, and instances. Its sessions stay readable. |
| `POST` | `/agents/{idOrName}/rename` | `{ "name": "new-name" }` | Rename in place; the id, versions, and sessions stay. `409` if the name is taken. |
| `POST` | `/plugin-artifacts` | packed plugin (`.tgz`, ≤ 25 MB); query `name`, `version`, `integrity` | Upload a local plugin so a deploy can use it. Returns the `artifactKey` to list in `pluginArtifacts`. |
| `POST` | `/agents` | raw `agent.yaml`, or JSON | **Legacy.** Deploy with the name taken from `agent.name`. Still works and answers with a `Deprecation` header; use `POST /agents/{name}/versions`. |
| `PUT` | `/agents/{agentId}` | raw `agent.yaml`, or JSON | **Legacy.** Add a version by agent id. Still works and answers with a `Deprecation` header; use `POST /agents/{name}/versions`. |

A deploy sends the raw `agent.yaml` (`Content-Type: text/yaml`), or JSON with
the config text and optional extras. The name in the path wins over
`agent.name` in the config.

```json
{
  "config": "<agent.yaml text>",
  "activate": true,
  "secrets": { "E2B_API_KEY": "e2b_..." },
  "pluginArtifacts": []
}
```

```json
{ "id": "agt_...", "name": "my-agent", "version": 1, "versionId": "ver_...", "active": true }
```

- `secrets` values are saved **agent-scoped** before the config is checked. An
  upload that does not go live (`activate: false` on an existing agent) cannot
  carry them.
- Every `${NAME}` secret reference must resolve to a value in the request, in
  the agent's secrets, or in the workspace's secrets; otherwise the deploy fails
  with `400 secret_unresolved` listing the missing names. A plain value in a
  config field that the plugin manifest declares as a secret fails with
  `400 secret_literal`.
- `pluginArtifacts` point at packages uploaded with `POST /plugin-artifacts`.
- A version that goes live also sets up the channels its config declares; the
  per-channel results are in `channels`.
- The `parel deploy` CLI does all of this for you.

Invalid config returns `400`:

```json
{
  "error": "Invalid agent config",
  "code": "config_invalid",
  "details": "version: Required; model: Required"
}
```

`POST /agents/validate` reports problems in the answer, not as an HTTP error:
`ok` is false when `errors` is not empty, and `warnings` never block a deploy.
Only a broken request (bad JSON, no `config`) gets a `400`.

```json
{
  "ok": false,
  "errors": [{ "code": "secret_unresolved", "message": "..." }],
  "warnings": [{ "code": "agent_name_exists", "message": "...", "path": "agent.name" }]
}
```

### Versions and Deployments

Wherever a version is asked for, give the number (`3`), the text `"v3"`, or the
version id.

| Method | Path | Body | Description |
| --- | --- | --- | --- |
| `GET` | `/agents/{idOrName}/versions` | none | List versions, newest first; `active: true` marks the live one. |
| `GET` | `/agents/{idOrName}/versions/{version}` | none | Get one version with its config. |
| `POST` | `/agents/{name}/deployments` | `{ "version": "v3", "dryRun"?: true }` | Make a version live, newer or older. With `dryRun: true` (or `?dryRun=true`) nothing changes and the answer checks that version against every instance's vars. |
| `GET` | `/agents/{idOrName}/deployments` | none | List when each version went live (`kind`: `deploy` \| `rollback`), newest first. |
| `POST` | `/agents/{idOrName}/rollback` | `{ "to"?: 3 }` | Make an earlier version live again. Without `to`, it goes back to the version that was live before the current one. |

```jsonc
// POST /agents/my-agent/deployments  { "version": "v3" }
{ "id": "agt_...", "name": "my-agent", "version": 3, "active": true }

// POST /agents/my-agent/deployments  { "version": "v4", "dryRun": true }
{ "id": "agt_...", "name": "my-agent", "version": 4, "dryRun": true, "active": false, "ok": true,
  "instances": [{ "key": "main", "tracking": "live", "affected": true,
                  "ok": true, "unresolved": [], "errors": [], "warnings": [] }] }
```

### Instances

An instance is one long-lived copy of an agent with its own state (sandbox,
memory), its own non-secret vars, and either the live version or a pinned one.
Every session runs on an instance. `main` always exists; any other key is
created the first time it is used. Keys are lowercase letters, digits, and
`._-`, up to 64 characters.

| Method | Path | Body | Description |
| --- | --- | --- | --- |
| `GET` | `/agents/{idOrName}/instances` | none | List instances (`main` included) with session counts and cost. |
| `GET` | `/agents/{idOrName}/instances/{key}` | none | Get one instance with its own vars (`vars_json`) and generation. |
| `PATCH` | `/agents/{idOrName}/instances/{key}` | `{ "tracking": "pinned", "version": "v3" }` \| `{ "tracking": "live" }` and/or `{ "vars": { ... } }` | Create or update one instance: pin it to a version or let it follow the live one, and/or replace its vars (full object). |
| `PATCH` | `/agents/{idOrName}/instances` | `[{ "key": "...", "vars"?: { ... }, "tracking"?: "...", "version"?: "..." }]` (≤ 500 items, keys unique) | Batch form of the single-key `PATCH` with identical per-item semantics. Returns `{ ok, results: [{ key, ok, instance } \| { key, ok: false, error }] }` in input order; invalid items are skipped, the rest applied; replaying the same body is safe. |
| `POST` | `/agents/{idOrName}/instances/{key}/reset` | `{ "generation"?: "..." }` | Wipe the instance's state (sandbox, memory) and add one to its generation counter. Sessions and their history stay. Repeating a reset with the same `generation` string returns the first result. |
| `DELETE` | `/agents/{idOrName}/instances/{key}` | none (`?force=true` ends live sessions first) | Delete an instance and its state. `409` while it has live sessions or a channel binding points at it. `main` can only be reset. |

```jsonc
// POST /agents/my-agent/instances/acme/reset  { "generation": "reset-2026-10-05" }
{ "reset": true, "key": "acme", "generation": "reset-2026-10-05", "instanceGeneration": 4 }
```

## Sessions

A session is one conversation with an agent. It runs on an instance (`main`
unless you name another) and keeps its history until it is terminated.

| Method | Path | Body | Description |
| --- | --- | --- | --- |
| `POST` | `/sessions` | `{ "agent", "instance"?, "version"?, "ephemeral"?, "requireExistingInstance"? }` | Start a session. |
| `GET` | `/sessions` | query | List sessions, most recently updated first. Query: `agent_id` (the id, not the name), `status`, `limit` (≤ 200, default 50), `offset`. |
| `GET` | `/sessions/{sessionId}` | none | Get a session's state, including `lastActivityAt` and what it is doing now. |
| `POST` | `/sessions/{sessionId}/fork` | `{ "input"?, "idempotencyKey"? }` | Copy the session's history and state into a new, independent session. See [Fork](#fork). |
| `POST` | `/sessions/{sessionId}/terminate` | `{ "reason"? }` | End a session: stops a running turn and refuses further messages. Safe to repeat. Returns `{ "terminated": boolean, "status": "..." }`; `terminated: false` means it had already ended. |
| `GET` | `/sessions/{sessionId}/commands` | none | List the slash commands this session accepts. See [Slash Commands](#slash-commands). |
| `GET` | `/sessions/{sessionId}/ws` | WebSocket subprotocol token | Open the session WebSocket (see [websocket.md](websocket.md)). |
| `POST` | `/agents/{idOrName}/sessions` | same fields, minus `agent` | **Legacy.** Start a session with the agent in the path. Still works; use `POST /sessions`. |

`POST /sessions` fields:

- `agent` (required): the agent's id or name.
- `instance`: the instance key (default `main`); created on first use.
- `version`: run that exact version on a throwaway instance. Cannot be combined
  with `instance`.
- `ephemeral: true`: a throwaway instance on the live version.
- `requireExistingInstance: true`: a missing instance is a `404
  instance_not_found` instead of being created.

```jsonc
// POST /sessions  { "agent": "my-agent", "instance": "acme" }
{ "id": "ssn_...", "agentId": "agt_...", "instance": "acme", "status": "ready" }   // 201

// POST /sessions  { "agent": "my-agent", "version": "v4" }
{ "id": "ssn_...", "agentId": "agt_...", "ephemeral": true, "version": "ver_...", "status": "ready" }
```

### Fork

`POST /sessions/{sessionId}/fork` copies the conversation so far into a new
session. With `input`, the new session runs it as its first message and the
response carries that turn's `turnId`; without it, the new session is created
idle. Send an `Idempotency-Key` header (or `idempotencyKey` in the body, up to
200 characters) so a retry returns the same copy (`200` with `replayed: true`)
instead of a second one; without a key the response carries a
`missing_idempotency_key` warning. Forked sessions keep the agent version they
came from.

```jsonc
// POST /sessions/ssn_.../fork   Idempotency-Key: fork-ticket-42
// { "input": "Now try the cheaper option" }
{ "id": "ssn_...", "status": "ready", "turnId": "trn_..." }   // 201
```

## Messages

Sending a message starts a turn, or queues the message while another turn runs.
The call returns right away; follow the turn over the WebSocket, through the
events, or with `GET /turns/{turnId}`.

| Method | Path | Body | Description |
| --- | --- | --- | --- |
| `POST` | `/sessions/{sessionId}/messages` | `{ "content": string \| Part[], "injectInFlight"?, "context"?, "expectedInstanceGeneration"? }` | Send a message, or run a slash command. See [Media Input](#media-input) and [Slash Commands](#slash-commands). |
| `GET` | `/sessions/{sessionId}/messages` | none | Read the transcript. `?view=chat` returns only what a chat window shows. |
| `POST` | `/sessions/{sessionId}/inputs` | `{ "type", "payload", "idempotencyKey"?, "context"? }` | Deliver an input that is not a user message (below). |
| `POST` | `/sessions/{sessionId}/steer` | `{ "content": "..." }` | **Deprecated alias** of `POST /sessions/{sessionId}/messages` with `injectInFlight: true`. |

Request options for `POST /sessions/{sessionId}/messages`:

- `Idempotency-Key` header (up to 200 characters): a retry with the same key
  never runs twice; it answers with the original input and turn, and
  `GET /sessions/{sessionId}/turns?by_idempotency_key=…` finds that turn later.
  The `inputId` is `inp_user_` followed by the key.
- `injectInFlight: true`: hands the message to the running turn at its next
  step boundary (announced by the WebSocket `input_absorbed` frame). With no
  turn running it starts one as usual. Slash commands never ride
  `injectInFlight`.
- `context`: an optional object passed to plugins that declare they consume
  invocation context. It does not enter the transcript.
- `expectedInstanceGeneration`: a non-negative integer; the call fails with
  `409 instance_generation_mismatch` if the instance was reset in the meantime.

```jsonc
// POST /sessions/ssn_.../messages   Idempotency-Key: ticket-42-msg-1
// { "content": "Summarize yesterday's tickets" }
{ "status": "accepted", "inputId": "inp_user_ticket-42-msg-1", "turnId": "trn_..." }
// a turn is already running:
{ "status": "queued", "inputId": "inp_user_ticket-42-msg-1" }
```

`status` is `accepted` (a turn started; see `turnId`), `queued` (a turn is
running; the message waits for the next turn, or with `injectInFlight` joins the
running turn at its next step), or `executed` (a slash command ran without a
turn; see `result`). An idempotent replay of an input that already
ran carries the original `turnId`. `warnings` lists things worth knowing, for
example `media_not_visible_to_model` or `idempotent_replay`.

Refusals: `400 media_invalid`, `413` when the message is too large, `429
rate_limited` when too many inputs are already waiting, and `409` when the
session cannot take a turn: `session_terminated`, `billing_insufficient`,
`billing_suspended`, `budget_exceeded`, `turn_limit`, or
`instance_generation_mismatch`.

### Inputs

`POST /sessions/{sessionId}/inputs` delivers platform inputs. `type` is one of:

| Type | Effect |
| --- | --- |
| `channel_event` | An external event for the session; wakes it and starts a turn. |
| `async_callback` | A callback result (for example from an async subagent or an approval); wakes the session. |
| `steer` | `payload.message` is delivered like a message with `injectInFlight: true`. |
| `interrupt` | Asks the running turn to stop. It is acted on by a plugin that consumes interrupts, such as `@parel/steering-immediate`. |

Pass the key as `idempotencyKey` or the `Idempotency-Key` header (up to 200
characters); without one the response carries a `missing_idempotency_key`
warning. `user_message` is refused: use `/messages`. Unknown types return
`400 invalid_request`.

### Steer (deprecated)

`POST /sessions/{sessionId}/steer` with `{ "content": "..." }` is kept for
existing callers. It behaves exactly like `POST /sessions/{sessionId}/messages`
with `injectInFlight: true` and accepts the same `Idempotency-Key` header. Its
response keeps the older field names:
`{ "queued", "id", "inputId", "mode", "started", "turnId"? }`. New callers
should use `/messages`.

## Slash Commands

A string `content` of the form `/name [args]` names a slash command when `name`
is one the session knows: the host's built-in `/help`, or a command a configured
plugin declares (see [plugins.md](plugins.md#slash-commands)). Such a message is
executed instead of starting a turn:

```jsonc
// POST /sessions/{sessionId}/messages  { "content": "/compact keep the billing decisions" }
// session idle → the command ran inline:
{ "status": "executed", "inputId": "inp_user_…", "command": { "name": "compact", "args": "keep the billing decisions" },
  "result": { "ok": true, "reply": "Compacted 12 message(s) …", "durationMs": 1830 } }
// a turn is running → the command waits its turn in the queue:
{ "status": "queued", "inputId": "inp_user_…", "command": { "name": "compact", "args": "…" } }
```

- `result.ok: false` carries `error` and `code: "command_failed"`.
- A command that expands into a prompt answers `status: "accepted"` with the
  `turnId` of the turn it opened, plus `command`.
- A `/name` the session does not know is delivered as an ordinary message; the
  response carries a `warnings` entry with `code: "unknown_command"`.
- `GET /sessions/{sessionId}/commands` returns
  `[{ "name", "description", "args"?: { "description" }, "source": "host" | "<plugin package>" }]`
  without starting a plugin runtime. `/help` renders the same list.
- Slash commands never enter the transcript; their execution is recorded as
  `command:start` / `command:end` events and the WebSocket `command_result` event.
- A `/name` message never rides `injectInFlight`; commands run at turn boundaries only.

## Media Input

`POST /sessions/{sessionId}/messages` accepts `content` as a plain string or a
parts array. Media is **inline base64 only** — there is no upload endpoint, no
media resource object, and no URL fetching.

```jsonc
{ "content": [
    { "type": "text",  "text": "What color is this?" },
    { "type": "image", "data": "<base64>", "mediaType": "image/png" },
    { "type": "file",  "data": "<base64>", "mediaType": "application/pdf", "filename": "spec.pdf" }
] }
```

Rules (violations return `400 media_invalid` / `413 media_too_large`):

- Allowed media types: `image/png`, `image/jpeg`, `image/gif`, `image/webp`
  (as `image` parts), `application/pdf` (as a `file` part). The declared
  `mediaType` must match the content's magic bytes.
- v1 budgets: ≤ 1 MiB raw per item, ≤ 3 media items per message, ≤ 1.25 MiB
  raw total per message, ≤ 16 content parts per message, and the serialized
  request row ≤ ~1.9 MB. A text message can be up to 1 MiB. Budgets may be
  raised in later runtime versions; the error codes are stable.
- While a turn is running, additional media-bearing messages are accepted only
  while the pending input queue stays snapshot-safe; past that they return a
  retryable `429` — resend after the current turn completes.
- The WebSocket `message` frame accepts the same shape, bounded by the 1 MiB
  WS frame limit — send larger payloads over HTTP.
- Reads: `GET /sessions/{sessionId}/messages` returns media parts with full
  `data`; the WS `sync` snapshot and derived query mirrors omit bytes and mark
  those parts with `dataOmitted: true`.
- Whether the model can see media depends on the session's model capabilities
  (`vision`, `documents`); on models without them media parts are projected to
  text placeholders for that call only — the transcript is unchanged, and the
  response carries a `media_not_visible_to_model` warning.

## Turns

A turn is one round trip, from an input to the agent's final reply. Its outcome
is kept durably, so it can be looked up long after the event window has moved
on.

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/turns/{turnId}` | Get the outcome of a turn. `404` for an unknown turn id. |
| `GET` | `/sessions/{sessionId}/turns?by_idempotency_key={key}` | Find the turn that handled the message sent with this `Idempotency-Key`. `404` means this session never received it. |

```jsonc
// GET /turns/trn_...
{
  "id": "trn_...", "sessionId": "ssn_...", "agentId": "agt_...",
  "instanceKey": "main", "instanceGeneration": 0, "turnNumber": 3,
  "status": "error", "completionKind": "retryable",
  "errorCode": "rate_limited", "errorMessage": "...", "retryAfterMs": 30000,
  "createdAt": "...", "completedAt": "...", "terminal": true
}

// GET /sessions/ssn_.../turns?by_idempotency_key=ticket-42-msg-1
{ "inputId": "inp_user_ticket-42-msg-1", "id": "trn_...", "status": "completed", "terminal": true, ... }
```

- `status`: `queued`, `running`, and `paused` mean the turn is still in
  progress; `completed`, `error`, and `cancelled` are final. `terminal` tells
  you which group you have.
- `completionKind` says how a turn ended: `success`, `failed`, `retryable`
  (with `retryAfterMs`), `cancelled`, or `paused`.
- A message that is still queued has no turn fields yet:
  `{ "inputId", "sessionId", "status": "queued", "terminal": false }`. A
  message that was queued when the session was terminated reports
  `status: "cancelled"` with no turn fields. A slash command that ran without a
  turn reports `status: "executed"`.

## Events and Observability

Each session keeps a numbered event list. Read it in pages: pass the last
`nextSeq` you got as `since_seq`, and keep going while `hasMore` is true. If
your `since_seq` is older than `earliestAvailableSeq`, the events in between are
no longer kept.

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/sessions/{sessionId}/events` | A session's events in order. Query: `since_seq`, `limit` (≤ 5000, default 500). |
| `GET` | `/sessions/{sessionId}/steps` | What each step did: `model_reasoning`, `tool_call`, `tool_result`, and `turn_failed` records. Query: `since_seq`, `limit` (≤ 1000, default 200); same paging as events. |
| `GET` | `/sessions/{sessionId}/logs` | Detailed execution logs, including full model inputs. Retained for 14 days, at most the newest 2000 per session; export anything you need to keep longer. |
| `GET` | `/sessions/{sessionId}/trace` | The transcript with timing spans, as the console's trace view shows it. |
| `GET` | `/sessions/{sessionId}/runtime/spans` | Timing spans. Query: `since_seq`, `limit` (≤ 5000), `turn_id`, `name`. |
| `GET` | `/sessions/{sessionId}/otel` | The session's spans as OpenTelemetry (OTLP/JSON), to load into your own tracing tool. |
| `GET` | `/fleet/overview` | Workspace health over a window: sessions, errors, latency, and cost. Query: `window` = `1h`, `6h`, `24h` (default), `7d`, or `30d`. |
| `GET` | `/fleet/series` | The same numbers over time, per hour or per day. |
| `GET` | `/fleet/problems` | Sessions worth a look: failed, slow, or expensive ones. |

```jsonc
// GET /sessions/ssn_.../events?since_seq=120&limit=500
{
  "events": [
    { "id": "evt_...", "seq": 121, "type": "turn:start", "data": "{...}", "created_at": "..." }
  ],
  "hasMore": false,
  "nextSeq": 121,
  "earliestAvailableSeq": 1
}
```

Event types include `turn:start`, `turn:end`, `turn:error`, `turn:blocked`,
`input:absorbed`, `command:start`, `command:end`, and `session:terminated`.
Clients must tolerate unknown event types.

## Execution Snapshots

Execution snapshots are immutable, provider-neutral anchors on a session's
execution timeline. They are the substrate for debugger checkpoints, playground
branching, replay, eval, and incident inspection.

| Method | Path | Body | Description |
| --- | --- | --- | --- |
| `GET` | `/sessions/{sessionId}/execution/snapshots` | query | List a session's snapshots. |
| `POST` | `/sessions/{sessionId}/execution/snapshots` | snapshot capture options | Capture a manual snapshot. |
| `GET` | `/execution/snapshots/{snapshotId}` | none | Get one snapshot with its contents. |
| `POST` | `/execution/snapshots/{snapshotId}/branches` | branch options | Start a branch session from a snapshot. |
| `POST` | `/execution/snapshots/{snapshotId}/replays` | replay options | Start a replay session from a snapshot. |
| `GET` | `/execution/branches/{branchId}` | none | Get a branch or replay record, including the new session's id. |
| `GET` | `/sessions/{sessionId}/execution/pause-policies` | none | List a session's pause policies (breakpoints). |
| `POST` | `/sessions/{sessionId}/execution/pause-policies` | pause policy | Add a pause policy. |
| `DELETE` | `/execution/pause-policies/{policyId}` | none | Remove a pause policy. |
| `GET` | `/sessions/{sessionId}/execution/pauses` | none | List the times a session stopped at a pause policy. |
| `GET` | `/execution/pauses/{pauseId}` | none | Get one pause. |
| `POST` | `/execution/pauses/{pauseId}/resume` | resume options | Continue after a pause. |
| `POST` | `/execution/pauses/{pauseId}/cancel` | none | Cancel a pause; the session ends there. |

The runtime creates a snapshot at the end of every turn (`turn_end`). Clients
may also capture manual snapshots:

```http
POST /sessions/{sessionId}/execution/snapshots
```

```json
{
  "anchor": "manual",
  "label": "before payment approval",
  "useCase": "debugger",
  "metadata": { "source": "console" },
  "idempotencyKey": "ui-click-123"
}
```

Snapshot responses include the session state, timeline pointers, and material
needed for inspection:

```json
{
  "id": "exs_...",
  "sessionId": "ssn_...",
  "anchor": "manual",
  "state": { "id": "ssn_...", "status": "running" },
  "pointers": { "messageSeqEnd": 3, "eventSeq": 9 },
  "material": {
    "storeData": {},
    "inputQueue": []
  },
  "createdAt": "2026-06-02T00:00:00.000Z"
}
```

Supported anchors are `turn_start`, `step_start`, `before_model`,
`after_model`, `before_tool`, `after_tool`, `turn_end`, and `manual`.

## Execution Pauses

Pause policies are session-scoped breakpoint rules. The runtime checks policies
at supported execution anchors and, on a match, captures a snapshot, records an
`ExecutionPause`, marks the session `suspended`, and ends the current turn. The
WebSocket announces it with an `execution_pause` frame. The runtime enforces
`step_start`, `before_model`, `after_model`, `before_tool`, and `after_tool`
policies, optionally only for one `toolName` or `stepNumber`; `turn_start` and
`turn_end` are snapshot anchors, not live pause points. `oneShot: true` removes
the policy after it fires once.

```http
POST /sessions/{sessionId}/execution/pause-policies
```

```json
{
  "anchor": "step_start",
  "oneShot": true,
  "condition": { "stepNumber": 2 },
  "label": "before tool loop",
  "reason": "inspect store before continuing",
  "useCase": "debugger",
  "metadata": { "source": "console" }
}
```

When a pause is hit, clients can resume or cancel it:

```http
POST /execution/pauses/{pauseId}/resume
```

```json
{
  "input": "Continue, but validate the payment payload first",
  "payload": { "approvedBy": "user" }
}
```

`input` is optional. If provided, the runtime starts a new turn with it after
marking the pause resumed. Cancel marks the pause cancelled and stops the paused
session.

Create a branch from a snapshot:

```http
POST /execution/snapshots/{snapshotId}/branches
```

```json
{
  "useCase": "playground",
  "mutations": {
    "inputOverride": "Try again with stricter validation",
    "modelOverride": "<model id>",
    "runtimeConfigOverride": { "maxSteps": 20 },
    "storePatch": { "plugin:key": "value" }
  },
  "run": true,
  "idempotencyKey": "branch-click-123"
}
```

The source session is not modified. The response points to the new branch
session:

```json
{
  "id": "exb_...",
  "sourceSnapshotId": "exs_...",
  "sourceSessionId": "ssn_...",
  "branchSessionId": "ssn_...",
  "mode": "branch",
  "status": "running",
  "useCase": "playground",
  "createdAt": "2026-06-02T00:00:00.000Z"
}
```

Branches seed the transcript, plugin store material, and input queue from the
snapshot. `inputOverride` can be used as the first turn input when `run` is
`true`; `storePatch` can override copied store keys. `modelOverride` replaces
`model.model` in the branch's agent config (same provider), and
`runtimeConfigOverride` shallow-merges into `runtime`.

Replay uses the same snapshot materialization path but records `mode: "replay"`:

```http
POST /execution/snapshots/{snapshotId}/replays
```

```json
{
  "useCase": "debugger",
  "input": "Replay this turn with the same state",
  "run": true,
  "idempotencyKey": "replay-click-123"
}
```

Branch, replay, and fork sessions keep the agent version they came from.

## Channels (beta)

A channel lets an outside system start or continue sessions. A **connection**
is the link to that system; a **binding** routes its events to an agent. There
are two connection types: `webhook`, where the system posts events to PAREL,
and `managed_ws`, an always-on WebSocket that PAREL keeps open to the system. A
connector plugin speaks the system's protocol; `generic-webhook` and
`generic-ws` are built in, and `@parel/channel-slack-socket` and
`@parel/channel-telegram` are published.

A `webhook` connection needs `config.webhookSecret` set to a reference such as
`${WEBHOOK_SECRET}` that names a secret already stored for the workspace; events
are routed only when their signature checks out. Always-on (`managed_ws`)
connections need the Hobby plan (up to 3) or Pro; without one, creating or
starting such a connection returns `402 plan_limit`.

Channels can also be declared in `agent.yaml` (see
[agent-config.md](agent-config.md#channels)); deploying creates the connection
and binding.

### Connections

| Method | Path | Body | Description |
| --- | --- | --- | --- |
| `GET` | `/channels/connections` | none | List connections. |
| `POST` | `/channels/connections` | `{ "type", "plugin", "pluginVersion"?, "config"?, "start"?, "pluginArtifacts"? }` | Create a connection. `start` applies to `managed_ws` only. |
| `GET` | `/channels/connections/{connectionId}` | none | Get one connection. |
| `PATCH` | `/channels/connections/{connectionId}` | `{ "config"?, "pluginVersion"?, "pluginArtifacts"? }` | Change a connection in place (`config` is replaced whole). Its id, bindings, and conversations stay; a running `managed_ws` connection restarts. |
| `DELETE` | `/channels/connections/{connectionId}` | none | Delete a connection; `409` while bindings still use it. |
| `POST` | `/channels/connections/{connectionId}/start` | none | Turn a connection on; a `managed_ws` connection dials out (`502` if it cannot connect). |
| `POST` | `/channels/connections/{connectionId}/stop` | none | Turn a connection off. |
| `GET` | `/channels/connections/{connectionId}/status` | none | Live status of a connection. |
| `POST` | `/channels/connections/{connectionId}/reset-runtime` | none | Rebuild a stuck `managed_ws` connector from scratch; it reconnects by itself when it is meant to be on. |

```jsonc
// POST /channels/connections
{ "type": "webhook", "plugin": "generic-webhook", "config": { "webhookSecret": "${WEBHOOK_SECRET}" } }
// 201
{ "id": "chn_...", "type": "webhook", "plugin": "@parel/channel-generic-webhook", "status": "active" }
```

### Bindings

A binding routes one channel connection's inbound events to one agent, and
carries the per-binding capability bits: `observe` (agent-event push scopes),
`injectInFlight` (mid-turn injection of same-conversation events), and
`childSessions` (connector-spawned fork child sessions).

| Method | Path | Body | Description |
| --- | --- | --- | --- |
| `POST` | `/channels/bindings` | binding (below) | Route a connection's events to an agent. Always creates a new binding with a fresh id. |
| `GET` | `/channels/bindings` | none | List bindings. |
| `PATCH` | `/channels/bindings/{bindingId}` | `{ "observe"?, "injectInFlight"?, "childSessions"? }` | Change capability bits in place. |
| `DELETE` | `/channels/bindings/{bindingId}` | none | Delete a binding. |
| `POST` | `/channels/bindings/{bindingId}/reset` | `{ "externalKey"? }` | Start a conversation over (below). |

```http
POST /channels/bindings
```

```json
{
  "agentId": "agt_...",
  "connectionId": "chn_...",
  "routingPolicy": "per_subject",
  "instanceKey": "main",
  "observe": ["turn", "steps"],
  "injectInFlight": true,
  "childSessions": false
}
```

```json
{
  "id": "cbd_...",
  "agentId": "agt_...",
  "connectionId": "chn_...",
  "routingPolicy": "per_subject",
  "instanceKey": "main",
  "observe": ["turn", "steps"],
  "injectInFlight": true
}
```

- `agentId` must be the agent's id.
- `routingPolicy` picks the session for each event: `main` (one shared
  session, the default), `per_subject` (one per thread or chat), `per_actor`
  (one per user), or `isolated` (a new session for every event).
- `instanceKey` picks the instance (default `main`).
- `observe` reports the agent's progress back to the connector: `turn` (turn
  lifecycle), `steps` (reasoning / tool call / tool result trace), `pause`
  (execution pauses).
- `injectInFlight` hands new events from the same conversation to a running
  turn at its next step boundary.
- `childSessions` lets the connector open fork child sessions; it requires
  `main` routing.

Update capability bits in place with `PATCH` — the binding id and its routing
stay untouched:

```http
PATCH /channels/bindings/{bindingId}
```

```json
{
  "observe": ["turn", "steps", "pause"],
  "childSessions": true
}
```

- Patchable fields: `observe`, `injectInFlight`, `childSessions`. Anything
  else — including the routing identity (`agentId`, `connectionId`,
  `routingPolicy`, `instanceKey`, `filter`) — is rejected with `400`.
  Repointing a binding is a different operation: DELETE the old binding,
  then POST its replacement (this order lets the platform retire the old
  conversation mappings; inbound events during the brief unbound window are
  ignored, not queued).
- Idempotent: replaying the same body converges on the same state with no
  side effects, so reconcile loops can PATCH unconditionally. Concurrent
  PATCHes of different fields do not overwrite each other — only the
  supplied fields are written.
- Effect timing: the child-session gate reads the binding per effect
  (immediate); `observe` / `injectInFlight` are cached per running session —
  a PATCH is fully visible within at most 60 seconds.
- Bindings declared in an agent config's `channels[]` are re-asserted every
  time a version of that config goes live: a PATCH to such a binding lasts
  until the next deploy overwrites it. API-created bindings are only ever
  changed via PATCH.

**Use one binding per connection.** When more than one binding exists on a
connection, which row takes effect is an implementation detail — it is not part
of this contract and may change. Do not create parallel rows to switch
capability bits; use PATCH.

Reset a binding's conversation mapping (the next inbound event starts a fresh
session; the old session stays readable):

```http
POST /channels/bindings/{bindingId}/reset
```

```json
{ "externalKey": "channel-C042..." }
```

`externalKey` may be omitted for `main` routing (it defaults to the binding's
single conversation); other routing policies must name the key. Reset never
touches capability bits.

### Events, Deliveries, and Webhook Ingress

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| `GET` | `/channels/events` | API key | List received channel events. Query: `connectionId`, `sessionId`, `status`, `limit` (≤ 200). |
| `GET` | `/channels/connections/{connectionId}/events?by_envelope_id={id}` | API key | What happened to one event, looked up by the connector's own event id: the routing result plus the turn receipt. |
| `POST` | `/channels/deliveries` | API key | Queue an outgoing message through a connection. Body: `connectionId`, `sessionId`, `replyRoute`, `payload`, `idempotencyKey`. Answers `202`. |
| `POST` | `/webhooks/channels/{connectionId}` | None (signature) | Where the outside system posts its events. The connector checks the signature. |

For the built-in `generic-webhook` connector, sign the raw request body with
HMAC-SHA256 using the webhook secret and send the hex digest in the
`x-parel-signature` header (a `sha256=` prefix is accepted). Accepted events get
a `202`.

```http
POST /webhooks/channels/chn_...
Content-Type: application/json
x-parel-signature: sha256=<hex HMAC-SHA256 of the raw body>

{ "id": "evt-1001", "type": "ticket.created", "subject": "ticket-42", "data": { } }
```

## API Keys

| Method | Path | Body | Description |
| --- | --- | --- | --- |
| `GET` | `/api-keys` | none | List keys with their prefix, `scopes`, `expires_at`, `revoked_at`, and last use (never the key itself). |
| `POST` | `/api-keys` | `{ "name": "...", "scopes"?: "read"\|"write"\|"admin", "expires_in_days"?: number }` | Create a key. The full key appears in this response only. |
| `POST` | `/api-keys/{keyId}/revoke` | none | Revoke a key: it stops working at once and the record stays for audit. |
| `DELETE` | `/api-keys/{keyId}` | none | Delete a key. |

```jsonc
// POST /api-keys  { "name": "ci", "scopes": "write", "expires_in_days": 90 }
{ "id": "key_...", "name": "ci", "key": "pk_...", "key_prefix": "pk_1a2b...9f0e",
  "scopes": "write", "expires_at": "..." }   // 201
```

See [API Key Scopes](#api-key-scopes).

## Model Provider Keys

PAREL does not provide model access. Agents call models with the workspace's
own keys, and the model provider bills the workspace directly. Keys are stored
per credential provider id (`anthropic`, `openai`, `openrouter`, `deepseek`, …:
lowercase letters, digits, and dashes) and used by every agent in the
workspace, unless its config sets `model.config.apiKey`. The console page is
Settings → Model providers.

| Method | Path | Body | Description |
| --- | --- | --- | --- |
| `GET` | `/providers` | none | List suggested model providers and whether the workspace has a key for each. |
| `GET` | `/provider-keys` | none | List stored provider keys (`id`, `provider`, `key_prefix`, `created_at`). |
| `POST` | `/provider-keys` | `{ "provider": "anthropic", "key": "..." }` | Add or replace the key for one provider. Admin scope. |
| `DELETE` | `/provider-keys/{keyId}` | none | Delete a provider key. Admin scope. |

## Secrets

Named values referenced from agent configs as `${NAME}` (uppercase env-var
style, `UPPER_SNAKE_CASE`). Stored encrypted; values never appear in responses —
only a short `value_prefix`. A secret is set for the whole workspace (empty
`agent_id`), for one agent (`agentId`), or for one instance of an agent
(`agentId` plus `instanceKey`); the narrowest one wins at session start. Writes
need an Admin key.

| Method | Path | Body | Description |
| --- | --- | --- | --- |
| `GET` | `/required-secrets` | none | List every `${NAME}` the workspace's deployed agents reference, and whether it is set. |
| `GET` | `/secrets` | none | List secrets (`id`, `name`, `agent_id`, `instance_id`, `value_prefix`, timestamps). |
| `POST` | `/secrets` | `{ "name": "E2B_API_KEY", "value": "...", "agentId"?: "agt_...", "instanceKey"?: "acme" }` | Create or replace a secret. Workspace-scoped unless `agentId` is set; `instanceKey` requires `agentId` and creates the instance if needed. |
| `DELETE` | `/secrets/{secretId}` | none | Delete a secret. |

```jsonc
// POST /secrets
{ "name": "E2B_API_KEY", "value": "e2b_..." }
{ "name": "CRM_TOKEN", "value": "...", "agentId": "agt_...", "instanceKey": "acme" }
```

## Billing

| Method | Path | Body | Description |
| --- | --- | --- | --- |
| `GET` | `/billing/summary` | none | Token and estimated model cost totals, by agent, by model, and by day. |
| `GET` | `/billing/usage` | query | Model call records, newest first. Query: `limit` (≤ 200), `offset`. |
| `GET` | `/billing/plan` | none | Plan and this month's metered usage: `plan`, `status`, `month`, `steps`, `connectionDays`, `usageUsd`, `includedSteps`, `includedUsd`, `overageUsd`, `spendCapUsd`, `limitReached`. |
| `PUT` | `/billing/spend-cap` | `{ "usd": 20 }` | Set the monthly overage cap of a paid plan (0 to 10000). Hobby and Pro only. |
| `POST` | `/billing/checkout` | `{ "plan": "hobby" \| "pro" }` | Start a subscription checkout. Returns `{ "url" }`. |
| `POST` | `/billing/portal` | none | Open the billing portal (change plan, cancel, card, invoices). Returns `{ "url" }`. |
| `GET` | `/billing/balance` | none | **Legacy.** Always returns zero: the hosted service keeps no prepaid balance. |

Billing endpoints are part of the hosted service contract. The hosted service
does not provide model access: model calls run on provider keys the workspace
supplies (a workspace provider key or a `model.config.apiKey` secret reference),
and the provider bills the workspace directly.

The hosted service meters the runtime itself: one **step** is one model call the
runtime made and received usage for (sub-agent and plugin calls included), and
an **always-on connection** is an enabled `managed_ws` channel connection,
counted per day. Usage is summed per UTC calendar month against the plan's
monthly allowance. When the Free plan's allowance or a paid plan's spend cap is
used up, new turns are refused with error code `billing_insufficient`; enabling
a connection beyond the plan's limit is refused with `plan_limit`. Prices and
plans: <https://parel.sh/pricing>.
