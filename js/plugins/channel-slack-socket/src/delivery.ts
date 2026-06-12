import type { ChannelDelivery, ConnectorContext, ConnectorEffect } from "@parel/plugin-sdk";
import { ChannelConnectorError } from "./error.js";
import { isRecord, stringValue } from "./utils.js";

// Provider refs:
// - chat.postMessage: https://docs.slack.dev/reference/methods/chat.postMessage/
// - response_url: https://docs.slack.dev/interactivity/handling-user-interaction/
function routeData(delivery: ChannelDelivery): Record<string, unknown> {
	return isRecord(delivery.replyRoute.data) ? delivery.replyRoute.data : {};
}

function deliveryPayload(delivery: ChannelDelivery): Record<string, unknown> {
	if (isRecord(delivery.payload)) return delivery.payload;
	return { text: String(delivery.payload) };
}

function slackResponseUrlEffect(url: string, payload: Record<string, unknown>): ConnectorEffect {
	const body = { ...payload };
	delete body.method;
	delete body.params;
	return {
		type: "fetch",
		request: {
			url,
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		},
	};
}

function slackWebApiEffect(delivery: ChannelDelivery, ctx: ConnectorContext): ConnectorEffect {
	const botToken = ctx.secrets.botToken;
	if (!botToken) throw new ChannelConnectorError("Slack botToken secret is not configured", 503);

	const payloadBody = deliveryPayload(delivery);
	const method = typeof payloadBody.method === "string" ? payloadBody.method : "chat.postMessage";
	const params = isRecord(payloadBody.params) ? { ...payloadBody.params } : { ...payloadBody };
	delete params.method;

	const data = routeData(delivery);
	const channel = stringValue(params.channel) ?? stringValue(data.channel);
	if (method === "chat.postMessage" && !channel) {
		throw new ChannelConnectorError("Slack delivery requires channel", 422);
	}
	if (channel) params.channel = channel;
	if (params.thread_ts === undefined && typeof data.threadTs === "string") {
		params.thread_ts = data.threadTs;
	}
	if (params.text === undefined && typeof delivery.payload === "string") {
		params.text = delivery.payload;
	}

	return {
		type: "fetch",
		request: {
			url: `https://slack.com/api/${method}`,
			method: "POST",
			headers: {
				Authorization: `Bearer ${botToken}`,
				"Content-Type": "application/json; charset=utf-8",
			},
			body: JSON.stringify(params),
		},
	};
}

export function buildSlackDeliveryEffect(
	delivery: ChannelDelivery,
	ctx: ConnectorContext,
): ConnectorEffect {
	const payloadBody = deliveryPayload(delivery);
	const data = routeData(delivery);
	const responseUrl = stringValue(data.responseUrl);
	const useResponseUrl = payloadBody.responseUrl === true || !ctx.secrets.botToken;
	if (responseUrl && useResponseUrl) return slackResponseUrlEffect(responseUrl, payloadBody);
	return slackWebApiEffect(delivery, ctx);
}
