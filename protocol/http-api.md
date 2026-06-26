# HTTP API Protocol

The public HTTP API is JSON over HTTPS, except agent config upload, which accepts raw YAML.

Most endpoints require:

```http
Authorization: Bearer pk_...
```

Errors use [../schemas/api-error.schema.json](../schemas/api-error.schema.json).

## Health

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| `GET` | `/health` | No | Returns `{ "status": "ok" }`. |

## Agents

An agent is identified by its **name** (unique per org). Each deploy creates an
immutable **version** (`vN`); a **deployment** event puts a version live; rollback
re-points the active version without creating a new one.

| Method | Path | Body | Description |
| --- | --- | --- | --- |
| `POST` | `/agents` | raw `agent.yaml`, or JSON (below) | Deploy: upsert by `(org, name)`. A new name creates the agent at `v1`; an existing name creates a new version and makes it live. Returns `{ id, name, version }` (`201` create, `200` update). |
| `GET` | `/agents` | none | List agents. |
| `GET` | `/agents/{idOrName}` | none | Get agent details and active config. Accepts id or name. |
| `PUT` | `/agents/{agentId}` | raw `agent.yaml`, or JSON (below) | Id-addressed deploy: a new version of an existing agent. Never renames; `agents.name` is the identity and `agent.name` in the config is not validated here. |
| `DELETE` | `/agents/{agentId}` | none | Delete an agent (cascades its versions, deployments, and agent-scoped secrets). |
| `GET` | `/agents/{idOrName}/versions` | none | List versions, newest first (`active: true` marks the live one). |
| `GET` | `/agents/{idOrName}/deployments` | none | List the deployment timeline (`kind`: `deploy` \| `rollback`), newest first. |
| `POST` | `/agents/{idOrName}/rollback` | `{ "to": 3 }` (version number or id; omit for the previously live version) | Make an existing version live again. |
| `POST` | `/agents/{idOrName}/rename` | `{ "name": "new-name" }` | Rename in place (keeps id, versions, sessions). `409` if the name is taken. |

The JSON deploy form carries the config plus optional sidecars:

```json
{
  "config": "<agent.yaml text>",
  "pluginArtifacts": [],
  "secrets": { "E2B_API_KEY": "e2b_..." }
}
```

`secrets` values are upserted **agent-scoped** before validation. Deploys are
validated against `${NAME}` secret references in the config: a reference that
resolves to no request, agent, or org secret fails with `400` listing the
missing names; a literal value in a config field the plugin manifest declares
as a secret fails with `400` telling the caller to use a reference.

Invalid config returns `400`:

```json
{
  "error": "Invalid agent config",
  "details": "version: Required; model: Required"
}
```

## Sessions

| Method | Path | Body | Description |
| --- | --- | --- | --- |
| `POST` | `/agents/{agentId}/sessions` | none | Create a session. |
| `GET` | `/sessions` | query | List sessions. |
| `GET` | `/sessions/{sessionId}` | none | Get session state. |
| `GET` | `/sessions/{sessionId}/messages?view=chat` | none | Get transcript messages. |
| `GET` | `/sessions/{sessionId}/events` | query | Get persisted events. |
| `GET` | `/sessions/{sessionId}/logs` | none | Get logs. |
| `GET` | `/sessions/{sessionId}/trace` | none | Get trace view. |
| `GET` | `/sessions/{sessionId}/execution/snapshots` | query | List execution snapshots for a session. |
| `POST` | `/sessions/{sessionId}/execution/snapshots` | snapshot capture options | Capture a manual execution snapshot. |
| `GET` | `/sessions/{sessionId}/execution/pause-policies` | none | List execution pause policies. |
| `POST` | `/sessions/{sessionId}/execution/pause-policies` | pause policy | Set an execution pause policy. |
| `DELETE` | `/execution/pause-policies/{policyId}` | none | Delete an execution pause policy. |
| `GET` | `/sessions/{sessionId}/execution/pauses` | none | List execution pauses for a session. |
| `GET` | `/execution/pauses/{pauseId}` | none | Get one execution pause. |
| `POST` | `/execution/pauses/{pauseId}/resume` | resume options | Resume a paused execution. |
| `POST` | `/execution/pauses/{pauseId}/cancel` | none | Cancel a paused execution. |
| `GET` | `/execution/snapshots/{snapshotId}` | none | Get an execution snapshot by id. |
| `POST` | `/execution/snapshots/{snapshotId}/branches` | branch options | Create a branch session from a snapshot. |
| `POST` | `/execution/snapshots/{snapshotId}/replays` | replay options | Create a replay session from a snapshot. |
| `GET` | `/execution/branches/{branchId}` | none | Get an execution branch/replay record. |
| `POST` | `/sessions/{sessionId}/messages` | `{ "content": "..." }` | Start an async turn. |
| `POST` | `/sessions/{sessionId}/steer` | `{ "content": "..." }` | Queue steering input. |
| `GET` | `/sessions/{sessionId}/ws` | WebSocket subprotocol token | Open session WebSocket (see [websocket.md](websocket.md#authentication)). |

## Execution Snapshots

Execution snapshots are immutable, provider-neutral anchors on a session's
execution timeline. They are the substrate for debugger checkpoints, playground
branching, replay, eval, and incident inspection.

The runtime may create automatic snapshots at stable boundaries such as
`turn_end`. Clients may also capture manual snapshots:

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

Snapshot responses include the session state, policy, timeline pointers, and
material needed for inspection:

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

Pause policies are session-scoped breakpoint rules. The host checks policies at
supported execution anchors and, on a match, captures a snapshot, records an
`ExecutionPause`, marks the session `suspended`, and ends the current workflow as
blocked. The runtime enforces `step_start`, `before_model`, `after_model`,
`before_tool`, and `after_tool` policies; `turn_start` and `turn_end` are
snapshot anchors, not live pause points in the current runtime.

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

`input` is optional. If provided, the host starts a new turn after marking the
pause resumed. Cancel marks the pause cancelled and stops the paused session.

Create a branch from a snapshot:

```http
POST /execution/snapshots/{snapshotId}/branches
```

```json
{
  "useCase": "playground",
  "mutations": {
    "inputOverride": "Try again with stricter validation",
    "modelOverride": "claude-opus-4-20250514",
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

Current branch support seeds transcript, plugin store material, and input queue
from the snapshot. `inputOverride` can be used as the first turn input when
`run` is `true`; `storePatch` can override copied store keys. `modelOverride`
updates `model.model` in the branch agent config, and `runtimeConfigOverride`
shallow-merges into `runtime`.

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

## Secrets

Named values referenced from agent configs as `${NAME}` (uppercase env-var
style). Stored encrypted; values never appear in responses — only a short
`value_prefix`. A row with an empty `agent_id` is org-scoped; a non-empty
`agent_id` scopes the value to that agent and overrides the org value at
session start.

| Method | Path | Body | Description |
| --- | --- | --- | --- |
| `GET` | `/secrets` | none | List secrets (`id`, `name`, `agent_id`, `value_prefix`, timestamps). |
| `POST` | `/secrets` | `{ "name": "E2B_API_KEY", "value": "...", "agentId"?: "agt_..." }` | Upsert a secret (org-scoped unless `agentId`). |
| `DELETE` | `/secrets/{secretId}` | none | Delete a secret. |

## API Keys

| Method | Path | Body | Description |
| --- | --- | --- | --- |
| `GET` | `/api-keys` | none | List API keys (incl. `scopes`, `expires_at`, `revoked_at`). |
| `POST` | `/api-keys` | `{ "name": "...", "scopes"?: "read"\|"write"\|"admin", "expires_in_days"?: number }` | Create API key. |
| `POST` | `/api-keys/{keyId}/revoke` | none | Revoke a key (soft; kept for audit, rejected immediately). |
| `DELETE` | `/api-keys/{keyId}` | none | Delete API key. |

**Scopes.** `read` permits `GET` only; `write` permits resource mutations
(agents, sessions, messages); `admin` additionally permits key, provider-key,
secret, and billing management. Keys created without `scopes` default to
`write`. Expired (`expires_at` in the past) or revoked keys are rejected with `401`.

## Billing

| Method | Path | Body | Description |
| --- | --- | --- | --- |
| `GET` | `/billing/summary` | none | Usage summary. |
| `GET` | `/billing/usage` | query | Usage records. |
| `GET` | `/billing/balance` | none | Account balance. |
| `POST` | `/billing/topup` | `{ "amount": 10 }` | Create top-up checkout. |
| `PUT` | `/billing/auto-topup` | `{ "amount": 10, "threshold": 2 }` | Update auto top-up. |

Billing endpoints are part of the hosted service contract. Self-hosted runtimes may omit them.
