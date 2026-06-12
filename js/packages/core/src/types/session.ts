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

export interface ToolHandlerContext {
	session: Readonly<SessionState>;
	store: SessionStore;
	log: PluginLogger;
	invocation?: ToolInvocationIdentity;
}

export type ToolHandler = (
	params: Record<string, unknown>,
	ctx: ToolHandlerContext,
) => Promise<ToolHandlerReturn>;

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
