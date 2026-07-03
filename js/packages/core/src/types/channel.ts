export interface ReplyRoute {
	kind: "managed_ws" | "provider_http" | "webhook";
	connectionId: string;
	subject?: string;
	data?: unknown;
}

export interface ChannelEnvelope {
	id: string;
	orgId?: string;
	connectionId?: string;
	source: string;
	type: string;
	time?: string;
	subject?: string;
	actor?: unknown;
	data: unknown;
	/**
	 * Per-turn invocation context attached by the connector. Snapshotted at
	 * turn start and exposed only to plugins that declare
	 * `consumes.invocationContext` (e.g. a sandbox plugin flattens it into
	 * per-exec env). The platform delivers it verbatim and never interprets
	 * the keys.
	 */
	context?: Record<string, unknown>;
	replyRoute?: ReplyRoute;
	rawRef?: string;
	trust?: {
		signatureVerified?: boolean;
		connectionAuthenticated?: boolean;
	};
}
