import type {
	ChannelDelivery,
	ConnectorContext,
	ConnectorEffect,
	ReplyRoute,
} from "@parel/plugin-sdk";
import { ChannelConnectorError } from "./error.js";
import { isRecord } from "./utils.js";

// Provider refs:
// - Bot API request URL shape: https://core.telegram.org/bots/api#making-requests
// - sendMessage: https://core.telegram.org/bots/api#sendmessage
// - answerCallbackQuery: https://core.telegram.org/bots/api#answercallbackquery
function routeData(route: ReplyRoute): Record<string, unknown> {
	return isRecord(route.data) ? route.data : {};
}

function deliveryPayload(delivery: ChannelDelivery): Record<string, unknown> {
	if (isRecord(delivery.payload)) return delivery.payload;
	return { text: String(delivery.payload) };
}

export function buildTelegramDeliveryEffect(
	delivery: ChannelDelivery,
	ctx: ConnectorContext,
): ConnectorEffect {
	const botToken = ctx.secrets.botToken;
	if (!botToken) throw new ChannelConnectorError("Telegram botToken secret is not configured", 503);

	const payload = deliveryPayload(delivery);
	const method = typeof payload.method === "string" ? payload.method : "sendMessage";
	const params = isRecord(payload.params) ? { ...payload.params } : { ...payload };
	delete params.method;

	const data = routeData(delivery.replyRoute);
	const chatId =
		typeof params.chat_id === "string" || typeof params.chat_id === "number"
			? params.chat_id
			: typeof data.chatId === "string" || typeof data.chatId === "number"
				? data.chatId
				: delivery.replyRoute.subject;
	if (!chatId && method !== "answerCallbackQuery") {
		throw new ChannelConnectorError("Telegram delivery requires chat_id", 422);
	}
	if (chatId) params.chat_id = chatId;
	if (params.text === undefined && typeof delivery.payload === "string") {
		params.text = delivery.payload;
	}
	if (params.message_thread_id === undefined && typeof data.messageThreadId === "number") {
		params.message_thread_id = data.messageThreadId;
	}
	if (
		params.business_connection_id === undefined &&
		typeof data.businessConnectionId === "string"
	) {
		params.business_connection_id = data.businessConnectionId;
	}

	return {
		type: "fetch",
		request: {
			url: `https://api.telegram.org/bot${botToken}/${method}`,
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(params),
		},
	};
}
