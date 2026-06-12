// Host-provided runtime capability: the platform substrate for spawning and
// controlling linked durable child executions. The kernel does not know about
// subagents — the host (e.g. the Cloudflare runtime) provides this capability
// and plugins consume it via `ctx.require(PAREL_RUNTIME_CAPABILITY)`.
//
// Design: docs/async-subagent.md (in the runtime repo) §6.1.
//
// This is a type-only contract. Plugins (e.g. @parel/subagent,
// @parel/dynamic-workflow) build subagent/workflow semantics on top of it;
// `subagent` and `workflow` are deliberately NOT modeled here.

/** Capability name under which the host registers {@link RuntimeControl}. */
export const PAREL_RUNTIME_CAPABILITY = "parel.runtime";

/** Lifecycle status of a child invocation. `blocked` (awaiting input) is NOT `failed`. */
export type ChildInvocationStatus =
	| "queued"
	| "running"
	| "blocked"
	| "completed"
	| "failed"
	| "cancelled";

/**
 * What kind of execution a child invocation refers to. Only `"session"` is
 * implemented today; the others reserve room for the general execution graph
 * without repainting the contract.
 */
export type ChildInvocationKind = "session" | "turn" | "job" | "external";

/**
 * Policy a child inherits from its parent. Values may only NARROW the parent's
 * policy, never widen it; the host enforces this. Omitted fields inherit.
 */
export interface ChildPolicy {
	/** Tool exposure: inherit all parent tools, none, or an explicit narrowed allowlist. */
	tools?: "inherit" | "none" | string[];
	/** Model override; must be a model the parent is already permitted to use. */
	model?: string;
	/** Budget caps for this child subtree. */
	budget?: {
		maxTokens?: number;
		maxCostUsd?: number;
	};
}

/** A durable record of "one execution context spawned a downstream one". */
export interface ChildInvocation {
	id: string;
	/** Top of the tree; used for O(1) per-tree cost rollup and budget limits. */
	rootSessionId: string;
	parentSessionId: string;
	parentTurnId?: string;
	parentStepId?: string;
	parentToolCallId?: string;
	/** Present once a `kind: "session"` child has been created. */
	childSessionId?: string;
	kind: ChildInvocationKind;
	status: ChildInvocationStatus;
	/** Name of the plugin that created this invocation. */
	originPlugin?: string;
	idempotencyKey: string;
	/** Distance from the root (root = 0); bounded by the host's depth limit. */
	depth: number;
	/** Opaque reference to the child's result payload, once completed. */
	resultRef?: string;
	error?: unknown;
	metadata?: Record<string, unknown>;
	createdAt: string;
	updatedAt: string;
	completedAt?: string;
}

/** Where a child invocation was created from inside the parent execution. */
export interface ChildInvocationOrigin {
	parentTurnId?: string;
	parentStepId?: string;
	parentToolCallId?: string;
	originPlugin?: string;
}

/** Options for {@link RuntimeControl.startChildSession}. */
export interface StartChildSessionOptions {
	/**
	 * Agent ref/id the child session should run.
	 * Required for fresh/delegated children. Fork children default to the parent
	 * agent surface; if supplied for fork, the host must reject a different agent.
	 */
	agent?: string;
	/** Initial task/message handed to the child. */
	input: string;
	/**
	 * `"async"` (default): return immediately; the child's result is later
	 * delivered back to the parent as an input that triggers a new turn.
	 * `"sync"`: the caller polls via {@link RuntimeControl.getChild} itself.
	 */
	mode?: "async" | "sync";
	/** Whether the child starts from a fresh context or a fork of the parent conversation. */
	context?: "fresh" | "fork";
	/**
	 * Stable key that makes spawning idempotent across step/workflow retries.
	 * Convention: parentSessionId + turnId + stepId + toolCallId + plugin key.
	 */
	idempotencyKey: string;
	/** Inherited-and-narrowed policy for the child (see {@link ChildPolicy}). */
	policy?: ChildPolicy;
	/** Wall-clock deadline after which the host cancels the child and reports a timeout. */
	deadlineMs?: number;
	metadata?: Record<string, unknown>;
	/** Parent execution location used for lineage, tracing, and idempotency. */
	origin?: ChildInvocationOrigin;
}

/** Handle returned immediately by {@link RuntimeControl.startChildSession}. */
export interface ChildSessionHandle {
	childInvocationId: string;
	childSessionId: string;
}

/**
 * The host-provided runtime capability. Obtain it in `setup` via
 * `ctx.require<RuntimeControl>(PAREL_RUNTIME_CAPABILITY)` and close over it in
 * tool handlers. Plugins must NOT spawn work any other way (no bare HTTP calls,
 * no fire-and-forget promises) — only through this capability does the platform
 * get durable lifecycle, tracing, billing, cancellation and idempotency.
 */
export interface RuntimeControl {
	/** Create a child session. Returns immediately; never blocks the parent turn. */
	startChildSession(opts: StartChildSessionOptions): Promise<ChildSessionHandle>;
	/** Fetch the current state of a child invocation. */
	getChild(childInvocationId: string): Promise<ChildInvocation>;
	/** Request cancellation of a running child (and, by default, its descendants). */
	cancelChild(childInvocationId: string): Promise<void>;
	/** Send a follow-up message to a running child (e.g. to redirect it). */
	signalChild(childInvocationId: string, message: string): Promise<void>;
	// No wait(): in async mode the child's result arrives as a parent input,
	// so no blocking primitive is needed (and none fits the serverless model).
}
