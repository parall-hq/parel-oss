import type { ConnectorContext, ConnectorEffect, WebhookRequest } from "@parel/plugin-sdk";
import { ChannelConnectorError } from "./error.js";
import { envelopeFromUpdate, parseTelegramUpdate } from "./normalize.js";
import { timingSafeEqualString } from "./utils.js";

// Provider ref: https://core.telegram.org/bots/api#setwebhook
export function handleTelegramWebhook(
	req: WebhookRequest,
	ctx: ConnectorContext,
): ConnectorEffect[] {
	const expected = ctx.secrets.webhookSecret;
	if (expected) {
		const provided = req.headers["x-telegram-bot-api-secret-token"];
		if (!provided || !timingSafeEqualString(provided, expected)) {
			throw new ChannelConnectorError("Invalid Telegram webhook secret token", 401);
		}
	}
	return [{ type: "emitEvent", event: envelopeFromUpdate(ctx, parseTelegramUpdate(req.bodyText)) }];
}
