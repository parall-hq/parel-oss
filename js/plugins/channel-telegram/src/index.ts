import type {
	ChannelConnector,
	ChannelDelivery,
	ConnectorContext,
	ConnectorEffect,
	WebhookRequest,
} from "@parel/plugin-sdk";
import { buildTelegramDeliveryEffect } from "./delivery.js";
import { handleTelegramWebhook } from "./webhook.js";

const connector: ChannelConnector = {
	async onWebhook(req: WebhookRequest, ctx: ConnectorContext): Promise<ConnectorEffect[]> {
		return handleTelegramWebhook(req, ctx);
	},

	async deliver(delivery: ChannelDelivery, ctx: ConnectorContext): Promise<ConnectorEffect[]> {
		return [buildTelegramDeliveryEffect(delivery, ctx)];
	},
};

export default connector;
