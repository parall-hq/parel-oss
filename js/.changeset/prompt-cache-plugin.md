---
"@parel/prompt-cache": minor
"@parel/core": minor
"@parel/plugin-sdk": minor
"@parel/cli": patch
---

New first-party plugin `@parel/prompt-cache`: before every model call it marks the end of the conversation history as cacheable, so Anthropic models read the history from the prompt cache instead of billing it as fresh input on every step, and gives OpenAI-family calls a per-session `prompt_cache_key`. It leaves authored cache settings alone (`promptCache.enabled: false`, `mode: "off"`, an explicit `breakpoints` plan, a tail hint, an existing key). `PromptCacheOptions` now types the fields the runtime already reads — `breakpoints` (`PromptCacheBreakpoint`, `PromptCacheControl`, `PromptCacheTarget`), `ttl` and `scope` — and the plugin SDK re-exports them. The CLI lists the plugin as the `prompt.cache` capability. Protocol: protocol/model-calls.md#prompt-cache.
