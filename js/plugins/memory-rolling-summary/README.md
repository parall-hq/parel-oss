# @parel/memory-rolling-summary

> PAREL plugin for rolling conversation memory summaries.

A first-party runtime plugin for [PAREL](https://github.com/parall-hq/parel-oss).

## Install

```bash
npm install @parel/memory-rolling-summary
```

## Usage

```yaml
plugins:
  - memory-rolling-summary
```

Options (all optional):

| Key | Default | Meaning |
|---|---|---|
| `max_context_tokens` | the model adapter's advertised window, else 100 000 | budget the summary keeps the window under |
| `compact_at` | `0.8` | fraction of the budget at which older messages fold into the summary |
| `keep_recent_tokens` | `20000` | recent conversation always kept verbatim after the summary, in tokens (at most half of the fold threshold) |
| `summary_max_tokens` | `16000` | output limit of the summary call; lower it for models with a smaller output cap |

`keep_recent_messages` is no longer read; the recent window is measured in
tokens.

Compaction runs at `step:end` and `turn:end`. It folds once the window reaches
`max_context_tokens × compact_at`, where the window is the input the last model
call reported (input + cache read + cache write tokens) plus an estimate of the
messages added since; before any call has reported, an estimate of the
un-summarized history. The kept window never splits a tool call from its
result. In the summary call's input, long tool results, tool arguments and text
keep their head and a `[truncated N chars]` marker. A failed automatic
compaction is logged with its cause and tried again next turn; `/compact
[focus]` folds on demand at any time.

The plugin declares `consumes.transcript: "lazy"`: on hosts that serve the
transcript reader it pulls only the not-yet-summarized tail through
`hookCtx.transcript.read({ fromSeq })` instead of receiving the whole history on
every hook; on older hosts it falls back to the pushed `messages`. The persisted
transcript is never modified — the plugin only shapes the per-call context
window.

## License

MIT — see [LICENSE](./LICENSE).
