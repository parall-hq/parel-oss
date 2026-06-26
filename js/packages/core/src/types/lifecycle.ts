import type {
	InputQueue,
	Message,
	ModelCallParams,
	ModelResponse,
	SessionState,
	SessionStore,
	ToolCall,
	ToolDefinition,
	ToolHandler,
	ToolRegistrationOptions,
	ToolResult,
} from "./session.js";

export const LifecycleEvent = {
	SessionStart: "session:start",
	SessionResume: "session:resume",
	SessionSuspend: "session:suspend",
	SessionEnd: "session:end",

	TurnStart: "turn:start",
	TurnEnd: "turn:end",

	StepStart: "step:start",
	ContextBuild: "context:build",
	ModelBefore: "model:before",
	ModelAfter: "model:after",
	ToolBefore: "tool:before",
	ToolAfter: "tool:after",
	StepEnd: "step:end",

	Checkpoint: "checkpoint",
	Error: "error",
} as const;

export type LifecycleEventType = (typeof LifecycleEvent)[keyof typeof LifecycleEvent];

export const HookPriority = {
	Early: 0,
	Security: 10,
	Normal: 100,
	Late: 200,
	Logging: 250,
} as const;

// --- Hook Tool Operations (dynamic registration in hooks) ---

export interface HookToolOps {
	register(
		definition: ToolDefinition,
		handler: ToolHandler,
		options?: ToolRegistrationOptions,
	): void;
	unregister(name: string): void;
}

// --- Event Map: per-event context and mutation types ---

// biome-ignore lint/complexity/noBannedTypes: empty ctx for events with no extra data
type EmptyCtx = {};

export interface HookEventMap {
	"session:start": { ctx: EmptyCtx; mut: never };
	"session:resume": { ctx: EmptyCtx; mut: never };
	"session:suspend": { ctx: EmptyCtx; mut: never };
	"session:end": { ctx: EmptyCtx; mut: never };
	"turn:start": { ctx: EmptyCtx; mut: never };
	"turn:end": { ctx: EmptyCtx; mut: never };
	"step:start": { ctx: EmptyCtx; mut: never };
	"context:build": {
		ctx: { system: string; messages: Message[] };
		mut: { system?: string; messages?: Message[] };
	};
	"model:before": {
		ctx: { modelParams: ModelCallParams };
		mut: { modelParams?: ModelCallParams };
	};
	"model:after": {
		ctx: { modelResponse: ModelResponse };
		mut: never;
	};
	"tool:before": {
		ctx: { toolCall: ToolCall };
		mut: { toolCall?: ToolCall };
	};
	"tool:after": {
		ctx: { toolCall: ToolCall; toolResult: ToolResult };
		mut: { toolResult?: ToolResult };
	};
	"step:end": { ctx: EmptyCtx; mut: never };
	checkpoint: { ctx: EmptyCtx; mut: never };
	error: { ctx: { error: Error }; mut: never };
}

// --- Typed HookContext ---

interface HookContextBase {
	session: Readonly<SessionState>;
	store: SessionStore;
	inputs: InputQueue;
	tools: HookToolOps;
	// NOTE: per-turn invocation context on hook contexts (for policy/channel plugins)
	// lands in P1, together with host-side per-hook gated delivery — not exposed here
	// until that path is wired. Design: docs/invocation-context.md §10.
}

export type HookContext<E extends LifecycleEventType> = { event: E } & HookContextBase &
	HookEventMap[E]["ctx"];

// --- Typed HookResult ---

type HookActionCommon =
	| { action: "continue" }
	| { action: "skip" }
	| { action: "block"; reason: string }
	| { action: "suspend"; reason: string }
	| { action: "stop"; reason: string };

export type HookResult<E extends LifecycleEventType> = HookEventMap[E]["mut"] extends never
	? HookActionCommon
	: HookActionCommon | { action: "continue"; mutations: HookEventMap[E]["mut"] };

// --- Typed HookHandler ---

export type HookHandler<E extends LifecycleEventType> = (
	ctx: HookContext<E>,
	// biome-ignore lint/suspicious/noConfusingVoidType: async hooks may intentionally return no result
) => Promise<HookResult<E> | void>;

export interface HookOptions {
	priority?: number;
}
