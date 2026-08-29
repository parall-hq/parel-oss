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
| `keep_recent_messages` | `12` | messages always kept verbatim after the summary |

The plugin declares `consumes.transcript: "lazy"`: on hosts that serve the
transcript reader it pulls only the not-yet-summarized tail through
`hookCtx.transcript.read({ fromSeq })` instead of receiving the whole history on
every hook; on older hosts it falls back to the pushed `messages`. Compaction
runs at `step:end` and `turn:end`. The persisted transcript is never modified —
the plugin only shapes the per-call context window.

## License

MIT — see [LICENSE](./LICENSE).
