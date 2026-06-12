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
	replyRoute?: ReplyRoute;
	rawRef?: string;
	trust?: {
		signatureVerified?: boolean;
		connectionAuthenticated?: boolean;
	};
}
