# @parel/approval-tools

Approval request tools for PAREL coding agents.

This plugin registers `request_approval` and `check_approval`. Requests are
stored in the session store and rendered as normal tool output so a host UI or
channel can ask the user. Results are delivered back as `async_callback` inputs:

```json
{
  "callbackKind": "approval_result",
  "approvalId": "approval_call_123",
  "status": "approved",
  "comment": "Proceed"
}
```

The plugin updates the stored request and injects an `<approval_result>` message
on the callback turn. It does not implement a platform policy engine or a
product-specific approval UI.
