---
"@parel/memory-rolling-summary": minor
---

Read history through `hookCtx.transcript` (declares `consumes.transcript: "lazy"`): on hosts that serve the transcript reader the plugin pulls only the not-yet-summarized tail instead of receiving the whole history on every hook dispatch; older hosts keep working from the pushed `messages`. Compaction now also runs at `step:end` (a long agentic turn cannot blow the window between turn ends), the token budget defaults to the adapter's advertised `maxContextTokens` when `max_context_tokens` is not configured, and the high-water mark is a transcript path coordinate (`summarizedUptoSeq`) so pointer-forked sessions — whose seqs continue their parent's — stay correct. Existing `summarizedCount` state is read as a coordinate.
