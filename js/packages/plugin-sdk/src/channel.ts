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

export interface ConnectorContext {
	orgId: string;
	connectionId: string;
	pluginName: string;
	config: Record<string, unknown>;
	secrets: Record<string, string>;
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
