# @parel/prompt-cache

> PAREL plugin that caches the conversation history, not just the system prompt and tools.

A first-party runtime plugin for [PAREL](https://github.com/parall-hq/parel-oss).

## Install

```bash
npm install @parel/prompt-cache
```

## Usage

```yaml
plugins:
  - prompt-cache
```

No configuration. Add it to agents with long conversations or many steps per
turn: without it, only the system prompt and tool definitions are read from the
provider's prompt cache, and the whole conversation history is billed as fresh
input on every model call.

Before every model call (`model:before`) the plugin:

- Marks the last message as cacheable (a `cacheHint`; see
  [Prompt cache](https://github.com/parall-hq/parel-oss/blob/main/protocol/model-calls.md#prompt-cache)).
  On Claude models (the Anthropic Messages API), where the runtime places
  cache breakpoints, this adds one at the end of the history next to the
  system and tools breakpoints, so the next call reads everything up to its
  new messages from cache. The provider's default cache lifetime (5 minutes)
  applies. Anthropic charges cache writes above the plain input price, so a
  session that never makes a second call within 5 minutes pays a little more;
  every step or turn after the first within that window pays much less.
- Sets `prompt_cache_key` to `parel:<session id>` for OpenAI-family adapters,
  which cache automatically; the key keeps one session's calls on the same
  cache. Endpoints that reject unknown request fields (some
  `openai-compatible` servers) may refuse it; don't use the plugin with those.

Neither guarantees a cache hit: providers skip prompts below their minimum
cacheable size and drop entries after the lifetime.

## Opting out

The plugin never overwrites what is already set on the model call:

| Already set by the call or another plugin | Effect |
|---|---|
| `promptCache.enabled: false` or `promptCache.mode: "off"` | The plugin does nothing. |
| A non-empty `promptCache.breakpoints` plan | No message hint; the plan is used as written. |
| `cacheHint.eligible: false` on the last message | No message hint. |
| A `cacheHint` with other fields on the last message | Those fields are kept. |
| `providerOptions.openai.prompt_cache_key` (even `null` or `""`) | The key is kept. |

## License

MIT — see [LICENSE](./LICENSE).
