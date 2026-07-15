import type { ChannelEnvelope, ReplyRoute } from "@parel/core";

export interface ProviderHttpRequest {
	url: string;
	method?: string;
	headers?: Record<string, string>;
	body?: string;
}

export type ConnectorEffect =
	| { type: "send"; data: string | ArrayBuffer }
	/**
	 * Inject an inbound envelope. `deliverTo.childRef` targets a child session
	 * previously spawned via `spawnChildSession` instead of the binding's normal
	 * routing — the envelope still flows the full ingress path (dedupe, trust
	 * gate, audit), only session resolution changes. When `deliverTo` is present,
	 * childRef must be a non-empty string: a malformed target rejects the event
	 * instead of silently falling back to binding routing.
	 */
	| { type: "emitEvent"; event: ChannelEnvelope; deliverTo?: { childRef: string } }
	| { type: "setTimer"; key: string; at: number }
	| { type: "fetch"; request: ProviderHttpRequest; idempotencyKey?: string }
	| { type: "close"; reason?: string }
	/**
	 * Resolve an ExecutionPause surfaced via the `execution_paused` agent event (the
	 * human-in-the-loop decision backflow). Platform-executed with host-side authz —
	 * the pause must belong to this connection's org and to a session this connection
	 * routed to; the connector never holds platform credentials. `approve: true`
	 * resumes (the session unblocks; it does not auto-continue the interrupted tool
	 * call), `approve: false` cancels. `comment` is recorded in the pause's resume
	 * payload for audit. Resolving an already-resolved pause is a no-op.
	 */
	| { type: "resolvePause"; pauseId: string; approve: boolean; comment?: string }
	/**
	 * Spawn a child session off this connection's main conversation session
	 * (the connector decides WHEN, the platform executes). Idempotent on
	 * `childRef` — the same key always resolves to the same child; `context` is
	 * not part of the anchor, so the first successful spawn fixes the child and
	 * later retries' `context` is ignored. Platform-gated: the binding must opt
	 * in to child sessions (`childSessions`), its routing mode must be `main`,
	 * and the parent's subagent depth/concurrency limits apply. The child always
	 * runs the binding's agent, in both modes. Failures come back as a
	 * `child_spawn_failed` agent event — effects have no synchronous return, so
	 * that event is the only feedback channel. `input` starts the child's
	 * opening turn.
	 */
	| {
			type: "spawnChildSession";
			childRef: string;
			input: string;
			subject?: string;
			/**
			 * How the child's transcript is seeded. `"fork"` (default, the original
			 * behavior): snapshot the parent's transcript EXCLUDING any in-flight
			 * turn (turn-boundary fork; no half-finished output leaks), inheriting
			 * the parent's in-flight config/version and plugin session store.
			 * `"fresh"`: start from an empty transcript — NOT merely "fork minus
			 * transcript": the child provisions like a new session of the binding's
			 * agent (active deployment or instance pin, plugin store starts empty)
			 * and joins the parent's instance, so instance-scoped state is shared.
			 * Use it for work lanes (per-fire schedule/task dispatch) that should
			 * not pay for or see the main conversation's history. Any other value
			 * rejects with `invalid_request` instead of silently forking.
			 */
			context?: "fresh" | "fork";
	  };

export interface ConnectRequest {
	url: string;
	headers?: Record<string, string>;
	protocols?: string[];
}

export interface WebSocketFrame {
	data: string | ArrayBuffer;
}

export interface WebhookRequest {
	method: string;
	url: string;
	headers: Record<string, string>;
	bodyText: string;
}

export interface ChannelDelivery {
	id: string;
	orgId: string;
	connectionId: string;
	sessionId: string;
	replyRoute: ReplyRoute;
	payload: unknown;
	attemptCount: number;
}

export interface ConnectorStore {
	get(key: string): Promise<unknown>;
	set(key: string, value: unknown): Promise<void>;
	delete(key: string): Promise<void>;
	list(prefix?: string): Promise<string[]>;
}

export interface ConnectorContext {
	orgId: string;
	connectionId: string;
	pluginName: string;
	config: Record<string, unknown>;
	secrets: Record<string, string>;
	/**
	 * Durable per-connection key-value store. The platform persists it across reconnect
	 * and runtime eviction — use it for protocol state such as a resume cursor. Always
	 * provided by the runtime; optional here so existing connectors and test mocks that
	 * never touch it keep type-checking.
	 */
	store?: ConnectorStore;
	now(): number;
}

/**
 * Fields every AgentEvent variant carries. `envelopeIds` are the `ChannelEnvelope.id`s
 * the connector itself emitted, and `subject` mirrors the originating envelope's subject
 * — both ride on EVERY event so each one is independently correlatable to the
 * connector's own conversation keys (delivery is best-effort, so any single event can be
 * missed; subject-less channels can only correlate via envelope ids).
 */
interface AgentEventBase {
	sessionId: string;
	turnId: string;
	subject?: string;
	envelopeIds: string[];
	/**
	 * Present on every event from a connector-spawned child session: the opaque
	 * correlation key the spawnChildSession effect carried. Connectors should
	 * track child lifecycle by this key — it is the stable handle they minted;
	 * `sessionId` is a platform-internal identifier, not a correlation surface.
	 */
	childRef?: string;
}

/**
 * Agent execution events the platform pushes to a connector's `onAgentEvent` hook for
 * turns that were triggered by that connection's envelopes. Opt-in per binding (the
 * channel declaration's `observe` scopes) and best-effort: events are neither persisted
 * nor replayed — treat them as a display/status feed, never as a data-correctness source.
 *
 * All three scopes are live: turn lifecycle (`observe: [turn]`), step trace
 * (`model_reasoning` / `tool_call` / `tool_result`, `observe: [steps]`), and
 * `execution_paused` (`observe: [pause]`). The one exception is `child_spawn_failed`,
 * which is pushed regardless of the binding's observe scopes (see its doc).
 *
 * A `turn_completed` fires unconditionally on every cleanly finished turn — including
 * turns that produced no reply (`hadOutput: false`), which is the reliable
 * "processing ended" signal an external platform cannot otherwise get. Ordering note:
 * on the happy path `deliver` is invoked before `turn_completed`, but a retried
 * delivery may land after it — `hadOutput: true` means a reply was enqueued, not that
 * `deliver` already ran.
 */
export type AgentEvent =
	| (AgentEventBase & { type: "turn_started" })
	| (AgentEventBase & {
			type: "turn_completed";
			/** Whether the turn enqueued an outbound delivery back to this connection. */
			hadOutput: boolean;
	  })
	| (AgentEventBase & { type: "turn_failed"; error: string })
	| (AgentEventBase & { type: "model_reasoning"; text: string })
	| (AgentEventBase & { type: "tool_call"; callId: string; name: string; input: unknown })
	| (AgentEventBase & {
			type: "tool_result";
			callId: string;
			status: "ok" | "error";
			durationMs?: number;
			outputPreview?: string;
	  })
	| (AgentEventBase & {
			type: "execution_paused";
			pauseId: string;
			reason: string;
			detail?: { anchor?: string; toolName?: string; input?: unknown };
	  })
	/**
	 * A spawnChildSession effect failed. Not turn-scoped (no AgentEventBase
	 * fields): the child never existed. Pushed regardless of the binding's
	 * observe scopes — it is the direct asynchronous error channel for the
	 * connector's own effect, not ambient observability. `code`: disabled |
	 * unsupported_routing | no_binding | invalid_request | depth_limit |
	 * concurrency_limit | spawn_failed. Retrying the SAME childRef is always safe
	 * (the idempotency anchor prevents duplicate children) and is the right first
	 * response to any failure: transient causes (`concurrency_limit`, an
	 * interrupted spawn) converge on retry, and the config-shaped codes (disabled /
	 * unsupported_routing / no_binding / invalid_request) succeed once fixed. Only
	 * a terminally-failed ref keeps answering `spawn_failed` ("previously failed
	 * terminally") — mint a new ref to proceed.
	 */
	| {
			type: "child_spawn_failed";
			childRef: string;
			code: string;
			error: string;
			// Explicitly absent (not just omitted): keeps pre-narrowing access to the
			// turn-scoped common fields compiling as `T | undefined` across the union.
			sessionId?: undefined;
			turnId?: undefined;
			subject?: undefined;
			envelopeIds?: undefined;
	  };

/**
 * Effects an `onAgentEvent` hook may return: everything except `emitEvent` and
 * `spawnChildSession`. An agent event must never inject a new inbound envelope or
 * spawn new execution — a `turn_completed` handler that emitted an envelope (or
 * spawned a child whose completion pushes again) would be an unbounded self-trigger
 * loop — so spawn decisions belong on the inbound paths (onMessage / onWebhook). The
 * exclusion is enforced at the type level, and the platform additionally drops
 * offending effects that arrive at runtime.
 */
export type AgentEventEffect = Exclude<
	ConnectorEffect,
	{ type: "emitEvent" } | { type: "spawnChildSession" }
>;

export interface ChannelConnector {
	connect?(ctx: ConnectorContext): Promise<ConnectRequest>;
	onOpen?(ctx: ConnectorContext): Promise<ConnectorEffect[]>;
	onMessage?(frame: WebSocketFrame, ctx: ConnectorContext): Promise<ConnectorEffect[]>;
	onTimer?(timer: { key: string }, ctx: ConnectorContext): Promise<ConnectorEffect[]>;
	onClose?(
		event: { code?: number; reason?: string; wasClean?: boolean },
		ctx: ConnectorContext,
	): Promise<ConnectorEffect[]>;
	onWebhook?(request: WebhookRequest, ctx: ConnectorContext): Promise<ConnectorEffect[]>;
	deliver?(delivery: ChannelDelivery, ctx: ConnectorContext): Promise<ConnectorEffect[]>;
	/**
	 * Agent execution events for turns this connection's envelopes triggered (opt-in via
	 * the binding's `observe` scopes). Returns AgentEventEffect — ConnectorEffect minus
	 * `emitEvent` and `spawnChildSession` (see its doc for why). Typical effects here
	 * are `fetch` (e.g. a status API call) or `send`.
	 */
	onAgentEvent?(event: AgentEvent, ctx: ConnectorContext): Promise<AgentEventEffect[]>;
}

/**
 * Identity helper for authoring a channel connector with full type-checking. A connector
 * package's default export should be the ChannelConnector — the platform detects it by
 * shape. Declare `type: "channel"` plus `channel.connectionTypes` / `channel.sources` in
 * the package's `parel.plugin.json`.
 *
 * @example
 * export default defineChannelConnector({
 *   async connect(ctx) { return { url: ctx.config.gatewayUrl as string }; },
 *   async onMessage(frame, ctx) { ... },
 *   async deliver(delivery, ctx) { ... },
 * });
 */
export function defineChannelConnector(connector: ChannelConnector): ChannelConnector {
	return connector;
}
