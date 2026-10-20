---
"@parel/memory-rolling-summary": minor
---

Compaction now happens on long conversations instead of never starting or failing on every step:

- The fold trigger uses the input the last model call reported (input + cache read + cache write tokens, recorded at `model:after`) plus an estimate of the messages added since; the character estimate is only the fallback before any call has reported, and now counts CJK text at about a token per character.
- The summary call may write up to 16000 tokens (was 2000, which a thinking model could spend before writing anything); `summary_max_tokens` lowers it for models with a smaller output cap.
- A failed automatic compaction logs its real cause and is tried again next turn rather than on every step; `/compact` is never held back.
- The recent window is measured in tokens (`keep_recent_tokens`, default 20000, at most half the fold threshold) and replaces `keep_recent_messages`, which is no longer read. It never splits a tool call from its result and is never empty.
- Long tool results, tool arguments and text are cut to their head plus a `[truncated N chars]` marker in the summary call's input.
- `/compact` reports a summary model that returned no text as a failure instead of "nothing to compact". The manifest no longer carries its own stale `version`; package.json is the only one.
