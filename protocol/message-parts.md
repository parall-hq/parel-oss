# Message Parts Protocol

PAREL transcripts use provider-neutral `Message` objects with ordered `parts`. The schema is [../schemas/message.schema.json](../schemas/message.schema.json).

## Why Parts

LLM providers expose different content block formats. A single string cannot represent text, reasoning, tool calls, tool results, files, images, source references, and provider replay artifacts without losing information.

PAREL stores all durable transcript content as message part JSON.

## Message Roles

| Role | Meaning |
| --- | --- |
| `system` | Runtime/system instructions. Usually trace-visible only. |
| `user` | User input. |
| `assistant` | Model output, including reasoning and tool calls. |
| `tool` | Tool result messages sent back to the model. |

## Part Types

| Type | Meaning |
| --- | --- |
| `text` | User or assistant text. |
| `image` | Base64 image input. |
| `file` | Base64 file input. |
| `reasoning` | Provider reasoning, thinking, or summary content. |
| `tool_call` | A model-requested tool invocation. |
| `tool_result` | Tool output. |
| `source` | Provider or tool source/reference metadata. |

## Visibility

Each part may set `visibility`:

| Visibility | Meaning |
| --- | --- |
| `chat` | Safe for normal chat UI. |
| `trace` | Visible in trace/debug views. |
| `hidden` | Stored for replay or audit but omitted from normal UI. |

Reasoning visibility is provider-dependent. PAREL stores exposed reasoning in `reasoning` parts and uses `providerArtifacts` for data needed for replay but not useful or safe to show directly.

## Provider Artifacts

`providerArtifacts` preserve provider-specific replay material without leaking provider-specific shape into the core transcript.

Examples include Anthropic thinking signatures, redacted thinking blocks, and OpenAI Responses reasoning item identifiers.

`requiredForReplay` tells SDKs and exporters whether removing the artifact may make exact replay impossible.

`replayScope` indicates when an artifact may be reused:

| Scope | Meaning |
| --- | --- |
| `same_provider` | Only with the same provider. |
| `same_provider_model` | Only with the same provider and model. |
| `never` | Store for audit only, never replay. |

## Thinking Blocks Across Providers

Providers differ in how they expose thinking:

- Some stream reasoning text.
- Some stream summaries only.
- Some require opaque signatures for multi-turn replay.
- Some expose no reasoning block at all.

PAREL normalizes all visible reasoning into `reasoning` parts. It keeps provider-specific replay data in `providerArtifacts`. Clients should render `reasoning` parts based on `visibility`, not based on provider name.

