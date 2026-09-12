# Stopping work and holding instance execution

These additive endpoints use the same organization authorization as session and
instance management. `GET /agents/{agent}/instances/{key}/execution` advertises
`version: 1` when the runtime supports this contract.

## Stop a turn

Read `GET /sessions/{session}/execution` to obtain the current `turnId` and `busy`
state. Submit `POST /sessions/{session}/turns/{turn}/stop` to stop that exact turn.
The response is `{status: "stopping" | "unchanged", turnId}`. A delayed or repeated
request never stops a different turn. An idle session is unchanged.

`stopping` acknowledges the request, not completed cancellation. The runtime
cancels active model requests when possible and waits for the executing step to
settle before finalizing. Detached executors must report completion; receipt of
the request is not proof that external tools have stopped.

The normal turn receipt has `completionKind: "cancelled"` and
`errorCode: "turn_stopped"`. Clients must not automatically retry that work.
The session stays reusable, retaining its transcript, identity, and stores.
Already performed external actions are not rolled back. Late child callbacks
alone cannot restart a stopped session; a new external input can start a new turn.
`terminate` retains its existing permanent session retirement semantics.

## Hold new work across an instance

`PUT /agents/{agent}/instances/{key}/execution-holds/{operationId}` acquires a
persistent hold. The operation ID is a caller-generated, stable string of up to
128 ASCII letters, digits, underscores or hyphens. Reuse it when retrying the
same operation. A different holder returns HTTP 409.

The response contains `operationId`, `executions`, and `sessions`. Session entries
include `sessionId`, `turnId`, `busy`, `stopping`, and `pinned`. A hold prevents new
turns, child turns, queued callbacks, input normalization and slash commands from
starting. Already admitted work can finish. Inputs remain queued.

**A held instance is not necessarily idle.** Before moving shared resources,
require that every session reports `busy: false` and `executions` is empty while
`operationId` equals the requested ID. Failure or timeout must leave the hold in
place until the caller has established which resources are authoritative.
Membership enumeration includes sessions created before execution control was
available. The response uses current execution state; asynchronous session status
projections are not used as proof of idleness.

For resource migration, send `{ "refreshVars": true }` when acquiring the hold.
This permanently requires fresh instance variable reads before later work starts,
including in sessions pinned to a deployment. A failed variable read blocks work
instead of using old resource configuration. It does not change the pinned code
version. Update the authoritative instance variables before releasing the hold.
All involved plugins must already support the replacement resource configuration.

`DELETE /agents/{agent}/instances/{key}/execution-holds/{operationId}` releases
only that hold and wakes queued work. Retry after a partial wake failure. Holds do
not expire by time: elapsed time cannot prove an old writer has stopped. Released
operation IDs stay tombstoned, so delayed requests cannot recreate them or release
a later holder. Instance reset is rejected while a hold exists.

To stop all current instance work, acquire a hold, record the returned session /
turn identities, stop those turns, and poll their terminal receipts and instance
execution state. Release the hold after completion. Do not report success for a
partial stop. New independent work may start after release; a later resource
change must acquire its own hold and recheck idleness.
