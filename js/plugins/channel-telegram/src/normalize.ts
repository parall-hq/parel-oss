import type { ChannelEnvelope, ConnectorContext, ReplyRoute } from "@parel/plugin-sdk";
import { ChannelConnectorError } from "./error.js";
import { getPath, isRecord, numberAt, stringAt } from "./utils.js";

// Provider refs:
// - Update: https://core.telegram.org/bots/api#update
// - Message: https://core.telegram.org/bots/api#message
// - CallbackQuery: https://core.telegram.org/bots/api#callbackquery
export function parseTelegramUpdate(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		throw new ChannelConnectorError("Telegram webhook body must be JSON", 400);
	}
}

function updateId(body: unknown): string {
	const id = stringAt(body, "update_id");
	if (!id) throw new ChannelConnectorError("Telegram update_id is required", 422);
	return id;
}

function messageLike(body: unknown): unknown {
	return (
		getPath(body, "message") ??
		getPath(body, "edited_message") ??
		getPath(body, "channel_post") ??
		getPath(body, "edited_channel_post") ??
		getPath(body, "business_message") ??
		getPath(body, "edited_business_message") ??
		getPath(body, "callback_query.message")
	);
}

function updateType(body: unknown): string {
	if (!isRecord(body)) return "telegram.update";
	if (isRecord(body.callback_query)) return "telegram.callback";
	if (isRecord(body.inline_query)) return "telegram.inline_query";
	if (isRecord(body.business_message) || isRecord(body.edited_business_message)) {
		return "telegram.business_message";
	}
	if (
		isRecord(body.message) ||
		isRecord(body.edited_message) ||
		isRecord(body.channel_post) ||
		isRecord(body.edited_channel_post)
	) {
		return "telegram.message";
	}
	for (const key of Object.keys(body)) {
		if (key !== "update_id") return `telegram.${key}`;
	}
	return "telegram.update";
}

function actor(body: unknown): unknown {
	return (
		getPath(body, "message.from") ??
		getPath(body, "edited_message.from") ??
		getPath(body, "business_message.from") ??
		getPath(body, "edited_business_message.from") ??
		getPath(body, "callback_query.from") ??
		getPath(body, "inline_query.from") ??
		getPath(body, "channel_post.sender_chat")
	);
}

function replyRoute(ctx: ConnectorContext, body: unknown, subject: string | undefined): ReplyRoute {
	const message = messageLike(body);
	const businessConnectionId =
		stringAt(body, "business_message.business_connection_id") ??
		stringAt(body, "edited_business_message.business_connection_id");
	return {
		kind: "provider_http",
		connectionId: ctx.connectionId,
		subject,
		data: {
			provider: "telegram",
			chatId: subject,
			messageThreadId: numberAt(message, "message_thread_id"),
			businessConnectionId,
		},
	};
}

export function envelopeFromUpdate(ctx: ConnectorContext, body: unknown): ChannelEnvelope {
	const message = messageLike(body);
	const subject =
		stringAt(message, "chat.id") ??
		stringAt(body, "callback_query.message.chat.id") ??
		stringAt(body, "inline_query.from.id");
	return {
		id: updateId(body),
		source: "telegram.webhook",
		type: updateType(body),
		subject,
		actor: actor(body),
		data: body,
		replyRoute: replyRoute(ctx, body, subject),
		trust: { signatureVerified: Boolean(ctx.secrets.webhookSecret) },
	};
}
