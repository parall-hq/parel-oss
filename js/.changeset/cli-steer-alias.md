---
"@parel/cli": patch
---

`parel steer` help text: it sends a message into the running turn (alias for `POST /messages` with `injectInFlight: true`), seen by the model at the next step and kept in the transcript.
