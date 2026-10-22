---
"@parel/sandbox-e2b": minor
---

A sandbox E2B has reclaimed no longer breaks the agent until someone resets
the instance.

- When E2B says the stored sandbox does not exist (`SandboxNotFoundError`), the
  plugin creates a new one, stores its id in place of the old one (through
  `cas()` in instance mode), and puts a note in front of the next `bash`,
  `file_read` or `file_write` result telling the model the previous sandbox and
  its files are gone. Timeouts, network errors and 5xx still never replace or
  delete anything: they retry briefly, keep the stored id, and report the error.
- A failed reconnect at the start of a step no longer fails the step; the first
  tool call that needs the sandbox retries and reports the error.
- `timeout` now means idle time before reclaim: every reconnect passes it to
  E2B, and a foreground command whose time limit is longer than what is left
  lengthens the sandbox's timer first (lengthen-only, so sessions sharing a
  sandbox never shorten each other's).
- New `sandboxId` option for a sandbox managed outside PAREL (e.g.
  `sandboxId: ${var:SANDBOX_ID}`): the plugin only connects to it, a missing
  sandbox is a clear error, and stop or session end never kill it.
- New sandboxes carry E2B metadata (`parelOrgId`, `parelAgentId`,
  `parelInstanceKey`, `parelSessionId`), so one left behind can be found and
  cleaned up in E2B.
