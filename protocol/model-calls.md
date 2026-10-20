# Model Calls

Parel owns the model provider subsystem. These rules apply independently of the
application consuming Parel. Provider options are configured through
[agent.yaml](agent-config.md); runtime plugins remain a separate extension point.

## Completion and failure

A model response is successful only after its API's completion state is checked.
A closed connection alone is insufficient. Incomplete output, output limits,
filtering, and failed responses retain distinct error codes in the turn result.
The current response's tools execute only after response validation succeeds.

Temporary failures before model output may be retried within the same model call,
with a shared time budget and bounded attempts. This does not rerun preceding
steps, model hooks, or tools. Authentication and configuration failures, cancelled
calls, and incomplete protocol responses are not automatically retried. A retry
hint that exceeds the remaining call budget ends the call instead of shortening
the provider's requested wait. A plugin model callback reports its failure to the
plugin; it does not acquire the step executor's retry loop.

Cancellation stops model requests and retry waits and prevents further tool
dispatch when execution ownership is lost. It cannot undo a completed tool's
side effects. Applications and plugins own decisions to continue work, steer a
running turn, fork, or request another turn; model failure handling adds no such
business policy.

## Request correlation

Built-in provider adapters generate the following HTTP request headers by default
for step model calls and plugin model callbacks. They contain only execution
identifiers and counters, never prompts, credentials, organization fields, or
invocation context.

| Header | Value |
| --- | --- |
| `X-Parel-Call-Id` | Logical model call ID; unchanged across that call's retries. |
| `X-Parel-Attempt` | One-based attempt number within the call. |
| `X-Parel-Session-Id` | Session ID, when available. |
| `X-Parel-Turn-Id` | Turn ID, when available. |
| `X-Parel-Step` | Step number supplied by the execution host. |

Set the literal boolean `model.config.requestMetadata: false` to disable generated
headers for an endpoint. The default is `true`. Explicit `model.config.headers`
remain caller-owned and are still sent, as are authentication headers. Model
calls, billing, and turn receipts do not depend on the endpoint accepting or
storing correlation fields. Receivers must treat these fields as untrusted
metadata, not authentication or billing idempotency keys.

Clients integrating with earlier deployments that generated `X-Parall-*` headers
should accept both families during rollout, preferring each new field when
present. Deploy the receiver's compatibility change before upgrading the sender.

## Parameter formats

`model.config.parameterDialect` selects Chat Completions parameter conversion:

| Value | Output limit | Reasoning |
| --- | --- | --- |
| `openai` | `max_completion_tokens` | `reasoning_effort` (a level only) |
| `openrouter` | `max_tokens` | `reasoning.effort` (a level) or `reasoning.max_tokens` (a budget) |
| `compatible` | `max_tokens` | Reject enabled reasoning without an explicit supported format. |
| `parall` | Deprecated alias of `openrouter`; retained for existing configurations. | Same as `openrouter`. |

Without an explicit format, `openai` uses its native format; `openai-compatible`
preserves its historical `openrouter` format. No URL or model-name inference is
performed. A native-compatible endpoint, even with a GPT model name, should set
`parameterDialect: openai`. Responses and Anthropic use their own API fields;
Chat Completions dialect selection does not override them.

## Reasoning

With `runtime.reasoning.enabled`, what PAREL asks the provider for depends only
on what the agent configured, never on the model name:

| Configured | Anthropic Messages | Chat Completions / Responses |
| --- | --- | --- |
| `effort` | Adaptive thinking with `output_config.effort` | The dialect's level field |
| `budgetTokens` only | Manual thinking with `thinking.budget_tokens` | The dialect's budget field; a level-only format (`openai`, Responses) converts it: ≤ 4096 low, ≤ 8192 medium, above that high |
| Neither | As `effort: medium` | As `effort: medium` |

`model.config.thinkingMode` (Anthropic) overrides that choice: `adaptive` or
`enabled` (manual) runs as written, taking a missing level from the budget as
above and a missing budget from the level (low 4096, medium 8192, high 16384);
`disabled` turns thinking off. Manual thinking must fit below the output limit;
incompatible explicit limits fail before sending a request. Provider
configuration changes follow normal immutable agent versioning; existing pinned
sessions are not rewritten.

## Prompt cache

Plugins mark prompt units worth caching with a provider-neutral `cacheHint` on
messages, content parts, or tool definitions, usually at `model:before`. Before
sending, the runtime turns hints into cache breakpoints for adapters that place
them explicitly (Anthropic Messages: at most 4, 5 minute lifetime). The system
prompt and the tool definitions are candidates by default (priority 50 and 40);
a message or part is a candidate only when it has an `id` and a hint without
`eligible: false` (default priority 60). When a provider caps breakpoints, the
highest priorities win. Adapters that cache automatically (OpenAI-family) ignore
hints; their cache routing goes through `providerOptions.openai.prompt_cache_key`.

`ModelCallParams.promptCache` controls planning for one call: `enabled: false`
or `mode: "off"` plans nothing, and a non-empty `breakpoints` list is sent as
written instead of being planned. Breakpoints outside the adapter's advertised
limits (count, TTL, scope) fail the call before sending. The first-party
`@parel/prompt-cache` plugin hints the end of the conversation history.
