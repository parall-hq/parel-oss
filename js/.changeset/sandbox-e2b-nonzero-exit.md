---
"@parel/sandbox-e2b": patch
---

Restore the 1.x contract for failing commands: e2b SDK 2.x throws
`CommandExitError` on any non-zero exit, which crashed the bash tool and
sandbox exec with an opaque "Dynamic plugin runtime /tool failed with 500:
exit status 1" instead of returning the command's stderr/exit code to the
agent. Foreground command paths now treat `CommandExitError` as the result
(it implements `CommandResult`); genuine transport errors still throw.
