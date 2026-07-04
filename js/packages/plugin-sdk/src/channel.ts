import type { ChannelEnvelope, ReplyRoute } from "@parel/core";

export interface ProviderHttpRequest {
	url: string;
	method?: string;
	headers?: Record<string, string>;
	body?: string;
}

export type ConnectorEffect =
	| { type: "send"; data: string | ArrayBuffer }
	| { type: "emitEvent"; event: ChannelEnvelope }
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
	| { type: "resolvePause"; pauseId: string; approve: boolean; comment?: string };

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
}

/**
 * Agent execution events the platform pushes to a connector's `onAgentEvent` hook for
 * turns that were triggered by that connection's envelopes. Opt-in per binding (the
 * channel declaration's `observe` scopes) and best-effort: events are neither persisted
 * nor replayed — treat them as a display/status feed, never as a data-correctness source.
 *
 * Only the three `turn_*` events are emitted today (`observe: [turn]`); the step-trace
 * events (`model_reasoning` / `tool_call` / `tool_result`, `observe: [steps]`) and
 * `execution_paused` (`observe: [pause]`) are contract-reserved for upcoming slices.
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
	  });

/**
 * Effects an `onAgentEvent` hook may return: everything except `emitEvent`. An agent
 * event must never inject a new inbound envelope — a `turn_completed` handler that
 * emitted an envelope would start a turn whose completion emits again, an unbounded
 * self-trigger loop — so the exclusion is enforced at the type level, and the platform
 * additionally drops any `emitEvent` that arrives at runtime.
 */
export type AgentEventEffect = Exclude<ConnectorEffect, { type: "emitEvent" }>;

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
	 * `emitEvent` (see its doc for why). Typical effects here are `fetch` (e.g. a status
	 * API call) or `send`.
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
