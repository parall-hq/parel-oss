---
"@parel/core": minor
---

Add the transcript read handle to hook contexts (`hookCtx.transcript: TranscriptReader`, with `TranscriptReadRange`) and the `consumes.transcript: "lazy"` manifest declaration. A plugin that declares it pulls history by path-coordinate range instead of receiving the full `messages` array on every dispatch; hosts that serve the reader attach the handle, older hosts leave it undefined.
