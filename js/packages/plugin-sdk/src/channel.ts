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
	| { type: "close"; reason?: string };

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
