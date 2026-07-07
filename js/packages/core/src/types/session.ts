export interface SessionEvent {
	id: string;
	sessionId: string;
	timestamp: number;
	type: string;
	data: unknown;
}

export interface SessionState {
	id: string;
	agentId: string;
	orgId: string;
	status: SessionStatus;
	turnCount: number;
	stepCount: number;
	totalTokens: number;
	totalCostUsd: number;
	createdAt: number;
	updatedAt: number;
}

export type SessionStatus =
	| "initializing"
	| "running"
	/** Idle between turns: the previous turn finished cleanly and the session is accepting input. */
	| "ready"
	/** Parked mid-turn awaiting external input (hook suspend / approval). */
	| "suspended"
	| "completed"
	| "error"
	| "timeout";

export interface SessionStore {
	get<T = unknown>(key: string): Promise<T | null>;
	set<T = unknown>(key: string, value: T): Promise<void>;
	delete(key: string): Promise<void>;
	list(prefix?: string): Promise<string[]>;
}

/** A versioned entry in the instance-scoped store; `version` is the CAS token. */
export interface InstanceStoreEntry<T = unknown> {
	value: T;
	/** Monotonic per-key version, input to {@link InstanceStore.cas}. */
	version: number;
}

/**
 * Instance-scoped plugin state: shared by every session of the same agent
 * instance, surviving conversation resets. Unlike the per-session
 * {@link SessionStore} it is multi-writer — concurrent turns of sibling
 * sessions may write the same key — so prefer `cas()` for read-modify-write
 * (e.g. racing to create one shared sandbox: `cas(key, null, handle)`, and the
 * loser re-reads the winner's value). Namespaced per plugin by the host.
 */
export interface InstanceStore {
	get<T = unknown>(key: string): Promise<InstanceStoreEntry<T> | null>;
	/** Unconditional write (last-write-wins). */
	set<T = unknown>(key: string, value: T): Promise<void>;
	delete(key: string): Promise<void>;
	list(prefix?: string): Promise<string[]>;
	/**
	 * Compare-and-swap: writes only if the key's current version matches
	 * `expectedVersion` (`null` = key must not exist yet). Returns whether the
	 * write won.
	 */
	cas<T = unknown>(key: string, expectedVersion: number | null, value: T): Promise<boolean>;
	/**
	 * Compare-and-delete: removes the key only if its current version matches
	 * `expectedVersion`. The safe way to retire a shared resource handle — an
	 * unconditional delete() can erase a sibling's just-swapped-in replacement.
	 * Optional: probe (`istore.casDelete?.(…)`) and fall back to delete() on
	 * hosts that predate it.
	 */
	casDelete?(key: string, expectedVersion: number): Promise<boolean>;
}

/** Identity of the agent instance a session belongs to. */
export interface InstanceInfo {
	/** Instance key within the agent (e.g. "main", "customer-a"); null when ephemeral. */
	key: string | null;
	/** True for try-run / replay-fresh instances that die with the session. */
	ephemeral: boolean;
}

export type MessageRole = "system" | "user" | "assistant" | "tool";
export type MessageStatus = "streaming" | "completed" | "error";
export type MessagePartVisibility = "chat" | "trace" | "hidden";
export type ProviderReplayScope = "same_provider" | "same_provider_model" | "never";

export interface ProviderArtifact {
	id?: string;
	provider: string;
	artifactType: string;
	replayScope: ProviderReplayScope;
	requiredForReplay: boolean;
	payload: unknown;
	payloadHash?: string;
}

export type PromptCacheScope = "session" | "workspace" | "organization" | "provider";
export type PromptCacheVolatility = "static" | "session" | "workspace" | "turn";

export interface PromptCacheHint {
	/**
	 * Marks this prompt unit as eligible for provider prompt-cache planning.
	 * Runtime/provider adapters still decide whether and how to compile the hint.
	 */
	eligible?: boolean;
	/** Stable producer-owned identity for this prompt unit across turns/sessions. */
	stableId?: string;
	/** Higher priority hints are preferred when providers cap cache breakpoints. */
	priority?: number;
	/** Optional size estimate used by runtime planners before provider tokenization. */
	estimatedTokens?: number;
	/** Describes how often this prompt unit is expected to change. */
	volatility?: PromptCacheVolatility;
}

export interface PromptCacheOptions {
	enabled?: boolean;
	mode?: "auto" | "off";
	requireStableRequestShape?: boolean;
}

export interface PromptCacheCapabilities {
	explicitBreakpoints: boolean;
	cacheEditing: boolean;
	ttl?: string[];
	scopes?: PromptCacheScope[];
	maxBreakpoints?: number;
}

interface MessagePartBase {
	id?: string;
	visibility?: MessagePartVisibility;
	provider?: string;
	model?: string;
	providerArtifacts?: ProviderArtifact[];
	cacheHint?: PromptCacheHint;
}

export interface TextPart extends MessagePartBase {
	type: "text";
	text: string;
}

export interface ImagePart extends MessagePartBase {
	type: "image";
	data: string;
	mediaType: string;
}

export interface FilePart extends MessagePartBase {
	type: "file";
	data: string;
	mediaType: string;
	filename?: string;
}

export interface ReasoningPart extends MessagePartBase {
	type: "reasoning";
	text?: string;
	summary?: string;
}

export interface ToolCallPart extends MessagePartBase {
	type: "tool_call";
	toolCall: ToolCall;
}

export interface ToolResultPart extends MessagePartBase {
	type: "tool_result";
	toolCallId: string;
	content: string;
	isError?: boolean;
	refs?: ToolContentRef[];
	fullContentRef?: ToolContentRef;
	truncated?: boolean;
	originalByteLength?: number;
}

export interface SourcePart extends MessagePartBase {
	type: "source";
	sourceType: string;
	payload: unknown;
}

export type ContentPart = TextPart | ImagePart | FilePart;
export type MessagePart =
	| TextPart
	| ImagePart
	| FilePart
	| ReasoningPart
	| ToolCallPart
	| ToolResultPart
	| SourcePart;

/**
 * Where an inbound message came from, for multi-speaker / group-chat attribution.
 * Populated for messages materialized from external channel events; omitted for
 * direct user messages and model/tool output. All fields optional so connectors
 * can supply whatever they know.
 */
export interface MessageOrigin {
	/** Connector/source identifier, e.g. the channel envelope `source` ("wechat"). */
	channel?: string;
	/** Conversation/thread/group id within the channel (distinguishes group chats). */
	conversationId?: string;
	/** Speaker identity within the conversation (who sent this message). */
	author?: string;
}

export interface Message {
	id?: string;
	sessionId?: string;
	turnId?: string;
	seq?: number;
	role: MessageRole;
	parts: MessagePart[];
	cacheHint?: PromptCacheHint;
	provider?: string;
	model?: string;
	status?: MessageStatus;
	createdAt?: string;
	/** Provenance for channel-sourced messages; see {@link MessageOrigin}. */
	origin?: MessageOrigin;
}

export interface ToolCall {
	id: string;
	name: string;
	arguments: Record<string, unknown>;
}

export interface ToolResult {
	toolCallId: string;
	content: string;
	isError?: boolean;
	refs?: ToolContentRef[];
	fullContentRef?: ToolContentRef;
	truncated?: boolean;
	originalByteLength?: number;
}

export interface InputQueueItem {
	id: string;
	type: string;
	payload: unknown;
	source: string;
	timestamp: number;
	/**
	 * Opaque per-input invocation context: non-transcript, JSON-able metadata the
	 * ingress carries (e.g. routing identifiers). Snapshotted onto the turn and
	 * delivered to consuming plugins via `InvocationContext`. The platform does not
	 * interpret its keys. Design: docs/invocation-context.md.
	 */
	context?: Record<string, unknown>;
}

export interface InputQueue {
	drain(type: string): InputQueueItem[];
	drainWhere?(type: string, predicate: (item: InputQueueItem) => boolean): InputQueueItem[];
	peek(type: string): InputQueueItem[];
	push(item: Omit<InputQueueItem, "id" | "timestamp">): void;
}

export type JsonSchema7 = Record<string, unknown>;

export type ToolSchedulingMode = "exclusive" | "parallel";

export interface ToolScheduling {
	defaultMode?: ToolSchedulingMode;
	maxConcurrency?: number;
	group?: string;
}

export interface ToolDefinition {
	name: string;
	description: string;
	parameters: JsonSchema7;
	cacheHint?: PromptCacheHint;
	scheduling?: ToolScheduling;
}

export type ToolContentRef =
	| { type: "workspace_path"; path: string; mediaType?: string; metadata?: Record<string, unknown> }
	| { type: "sandbox_path"; path: string; mediaType?: string; metadata?: Record<string, unknown> };

export interface ToolOutput {
	content: string;
	isError?: boolean;
	refs?: ToolContentRef[];
	fullContentRef?: ToolContentRef;
	truncated?: boolean;
	originalByteLength?: number;
}

export type ToolHandlerReturn = string | ToolOutput;

export interface ToolInvocationIdentity {
	sessionId: string;
	turnId?: string;
	stepNumber?: number;
	toolCallId: string;
	toolName: string;
	pluginName?: string;
}

export interface ToolRegistrationOptions {
	scheduling?: ToolScheduling;
	isConcurrencySafe?: (params: Record<string, unknown>) => boolean | Promise<boolean>;
}

export interface PluginLogger {
	debug(message: string, data?: unknown): void;
	info(message: string, data?: unknown): void;
	warn(message: string, data?: unknown): void;
	error(message: string, data?: unknown): void;
}

/**
 * Per-turn invocation context: the opaque, non-transcript metadata carried by the
 * turn's originating input (see `InputQueueItem.context`), snapshotted at turn
 * start and immutable for the turn. Injected only into the tool contexts of plugins
 * that declare `consumes.invocationContext` (hook-context delivery is a later phase).
 *
 * Distinct from `ToolInvocationIdentity` (runtime-owned tool-call identity) — do
 * not conflate. Design: docs/invocation-context.md.
 */
export interface InvocationContext {
	inputId: string;
	turnId: string;
	context: Record<string, unknown>;
}

export interface ToolHandlerContext {
	session: Readonly<SessionState>;
	store: SessionStore;
	log: PluginLogger;
	invocation?: ToolInvocationIdentity;
	/**
	 * Per-turn invocation context; present only when this plugin's manifest
	 * declares `consumes.invocationContext`. Design: docs/invocation-context.md.
	 */
	invocationContext?: InvocationContext;
}

export type ToolHandler = (
	params: Record<string, unknown>,
	ctx: ToolHandlerContext,
) => Promise<ToolHandlerReturn>;

export interface NormalizeContext {
	session: Readonly<SessionState>;
	store: SessionStore;
	inputs: InputQueue;
	log: PluginLogger;
}

/**
 * Turns an inbound platform input (an `InputQueueItem` of a declared type, e.g.
 * "async_callback") into canonical transcript messages at intake. Returning
 * `null` DEFERS: the input is left untouched for the next registered normalizer,
 * a hook consumer, or the host's own type-specific handling. A normalizer must
 * claim only inputs it owns and must NOT rely on a blanket host fallback for
 * deferred inputs — `async_callback`, for instance, is a shared type whose
 * `approval_result` kind is consumed by a different plugin's hook, so a host
 * must not materialize a deferred callback as a generic text message. The host
 * persists the returned messages, so replay reuses the stored result and is
 * immune to plugin version drift.
 */
export type NormalizeHandler = (
	type: string,
	payload: unknown,
	ctx: NormalizeContext,
) => Promise<Message[] | null>;

export interface NormalizeRegistrationOptions {
	/** Lower runs earlier; the first non-null result wins. Defaults to 100. */
	priority?: number;
}

export interface ReasoningConfig {
	enabled: boolean;
	budgetTokens?: number;
}

export interface TokenUsage {
	/** Non-cached input tokens charged at the normal input-token rate. */
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens?: number;
	cacheWriteTokens?: number;
	cacheDeletedTokens?: number;
}

export interface ModelCallParams {
	messages: Message[];
	tools?: ToolDefinition[];
	maxTokens?: number;
	temperature?: number;
	topP?: number;
	topK?: number;
	seed?: number;
	stopSequences?: string[];
	reasoning?: ReasoningConfig;
	promptCache?: PromptCacheOptions;
	providerOptions?: Record<string, Record<string, unknown>>;
}

export type ProviderArtifactTarget = "current_text" | "current_reasoning" | "last_part";

export type ModelStreamChunk =
	| {
			type: "text_delta";
			text: string;
			providerArtifacts?: ProviderArtifact[];
	  }
	| {
			type: "text_end";
			providerArtifacts?: ProviderArtifact[];
	  }
	| {
			type: "reasoning_start";
			visibility?: MessagePartVisibility;
			providerArtifacts?: ProviderArtifact[];
	  }
	| {
			type: "reasoning_delta";
			text: string;
	  }
	| {
			type: "reasoning_end";
			text?: string;
			summary?: string;
			providerArtifacts?: ProviderArtifact[];
	  }
	| {
			type: "provider_artifact";
			target: ProviderArtifactTarget;
			artifact: ProviderArtifact;
	  }
	| {
			type: "tool_call";
			toolCall: ToolCall;
			providerArtifacts?: ProviderArtifact[];
	  }
	| {
			type: "usage";
			usage: TokenUsage;
	  };

export interface ModelResponse {
	text: string;
	parts: MessagePart[];
	toolCalls: ToolCall[];
	usage: TokenUsage;
	stopReason: "end_turn" | "tool_use" | "max_tokens" | "stop_sequence";
}

export interface ModelPricing {
	inputPer1M: number;
	outputPer1M: number;
	cacheReadPer1M?: number;
	cacheWritePer1M?: number;
}

export interface ModelCapabilities {
	modelId: string;
	provider: string;
	maxContextTokens: number;
	toolCalling: boolean;
	parallelToolCalls: boolean;
	streaming: boolean;
	vision: boolean;
	thinking: boolean;
	promptCache?: PromptCacheCapabilities;
	pricing?: ModelPricing;
}
