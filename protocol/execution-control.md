# Execution Control: Stop and Instance Holds

Two additive controls for hosts that expose `version: 1` from
`GET /agents/{agent}/instances/{key}/execution`:

- **Stop** ends one turn within seconds and keeps the session reusable.
- **Instance hold** pauses all new work of one agent instance while an operator
  changes resources the instance shares (for example, its sandbox).

They are independent: stopping work never requires a hold, and a hold never
stops work that is already running. Session `terminate` keeps its permanent
retirement semantics.

## Stop a turn

```
GET  /sessions/{session}/execution
POST /sessions/{session}/turns/{turn}/stop
```

`GET` returns the session's current execution:

```json
{ "sessionId": "ses_…", "turnId": "trn_…", "busy": true, "stopping": false, "paused": false }
```

`turnId` is the running turn, or the turn waiting on an execution pause when
`paused` is true; it is `null` when the session is idle.

`POST` stops exactly `{turn}` and returns `{ "status": "stopping" | "unchanged",
"turnId": "…" }`. A delayed or repeated request never affects a different turn.
`unchanged` means `{turn}` is not the session's current turn, or its outcome was
already decided (a completion that raced the stop wins).

What stopping does:

- The active model request is cancelled, including when the step runs outside
  the session's own process.
- In-flight tool calls are cancelled through the tool's abort hook (see
  [Tool cancellation](#tool-cancellation)); remaining tool calls of the step are
  not started. Every cancelled call receives a tool result saying it was
  stopped, so the transcript stays valid for the next model call.
- Child sessions started by the turn are stopped too, and their completion no
  longer wakes the parent.
- A turn waiting on an execution pause is finalized and its pause can no longer
  be resumed.
- Background processes that a tool deliberately detached (for example, a
  started dev server) are not affected.

`stopping` acknowledges the request, not completion. The turn's normal receipt
reports the end with `completionKind: "cancelled"` and `errorCode:
"turn_stopped"`. Clients must not retry stopped work automatically. The session
returns to `ready` with its transcript, identity, and stores intact. Actions a
tool had already performed are not rolled back.

After a stop, internal callbacks (a child result, an async tool callback) do
not start a new turn by themselves. The next external input — including a
message that was queued while the stopped turn ran — does.

## Hold new work across an instance

```
GET    /agents/{agent}/instances/{key}/execution
PUT    /agents/{agent}/instances/{key}/execution-holds/{operationId}
DELETE /agents/{agent}/instances/{key}/execution-holds/{operationId}
```

Work in an instance runs under **permits**. A session takes one permit when a
turn is admitted and one when a slash command runs outside a turn; it returns
the permit when the turn or command ends. A session waiting on an execution
pause holds no permit.

`GET` returns:

```json
{
  "version": 1,
  "hold": { "operationId": "op_…" },
  "permits": [
    { "sessionId": "ses_…", "executionId": "trn_…", "kind": "turn", "turnId": "trn_…", "stopping": false }
  ]
}
```

`hold` is `null` when no hold exists. `permits` is always present; clients must
treat a response without it as unsupported, never as idle. The instance is idle
exactly when `permits` is empty. Before answering, the host verifies each permit
with its session and drops permits whose session confirms it is not running
that execution, so a crashed process cannot leave a permanent permit.

`PUT` acquires a hold. The operation ID is a caller-generated string of up to
128 ASCII letters, digits, underscores, or hyphens; reuse it when retrying.
Body: `{ "refreshVars": boolean }` (optional). The response has the `GET` shape.
Another active hold, or an operation ID that was already released, returns
HTTP 409 with code `instance_execution_held`.

While a hold exists:

- New turns, slash commands, and child sessions of the instance are deferred.
  Their inputs stay queued; a request that would start work reports `queued`,
  not an error.
- Work that already holds a permit continues. A hold is not a stop; stop that
  work first when the operation needs an idle instance, then wait until
  `permits` is empty.
- Instance reset is rejected.

`refreshVars: true` is for resource migration. Every session of the instance
reads the latest instance variables once before its next work starts — also
sessions pinned to a deployment version, because a version pin fixes code, not
resource identity. A failed read keeps the input queued and retries; it never
falls back to the previous values. Update the instance variables before
releasing the hold. All involved plugins must support the new configuration.

`DELETE` releases the hold and wakes the work it deferred. It is idempotent and
also accepts an ID that was never acquired. HTTP 502 with code `wake_failed`
means the hold is released but some deferred work was not woken yet; retry the
`DELETE`. Released IDs stay tombstoned, so a
delayed `PUT` cannot recreate them or block a later operation.

Holds never expire: elapsed time cannot prove that an old writer has stopped.
An operator who has lost track of a hold reads its `operationId` from `GET` and
releases it with `DELETE` after confirming which resources are authoritative.
Do not roll a runtime back to a version without this protocol while a hold
exists.

## Tool cancellation

Plugins opt in per tool (see [plugins.md](plugins.md#tool-cancellation)):

- `ToolHandlerContext.signal` aborts when the turn stops. It fires only when the
  handler runs in the process that observed the stop.
- `ToolRegistrationOptions.abort({ toolCallId, sessionId, turnId })` is called
  out of band. It may run in another process, more than once, and before the
  handler has started. It must be idempotent and must make a later start of the
  same `toolCallId` a no-op. Tools that start external work (a shell command, a
  remote job) should implement it.

A tool without cancellation support runs to its own completion; the host still
does not start the step's remaining tools and finalizes the turn afterwards.
