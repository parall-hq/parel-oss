---
"@parel/sandbox-e2b": patch
---

Prevent destructive recovery from E2B reconnect failures. Every reconnect
error, including an explicit not-found response, now retries briefly and then
fails without creating a replacement, changing the stored sandbox id, or
deleting the old sandbox.
