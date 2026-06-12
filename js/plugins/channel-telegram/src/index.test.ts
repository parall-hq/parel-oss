import type { ConnectorContext } from "@parel/plugin-sdk";
import { describe, expect, it } from "vitest";
import connector from "./index.js";

function ctx(secrets: Record<string, string> = {}): ConnectorContext {
	return {
		orgId: "org_1",
		connectionId: "chn_1",
		pluginName: "@parel/channel-telegram",
		config: {},
		secrets,
		now: () => 123,
	};
}

describe("@parel/channel-telegram", () => {
	it("normalizes Telegram webhook messages", async () => {
		const effects = await connector.onWebhook?.(
			{
				method: "POST",
				url: "https://api.parel.test/webhooks/channels/chn_1",
				headers: { "x-telegram-bot-api-secret-token": "secret" },
				bodyText: JSON.stringify({
					update_id: 42,
					message: {
						message_id: 7,
						message_thread_id: 9,
						chat: { id: 123, type: "supergroup" },
						from: { id: 456, username: "ada" },
						text: "hello",
					},
				}),
			},
			ctx({ webhookSecret: "secret" }),
		);

		expect(effects?.[0]).toMatchObject({
			type: "emitEvent",
			event: {
				id: "42",
				source: "telegram.webhook",
				type: "telegram.message",
				subject: "123",
				actor: { id: 456, username: "ada" },
				replyRoute: {
					kind: "provider_http",
					connectionId: "chn_1",
					subject: "123",
					data: {
						provider: "telegram",
						chatId: "123",
						messageThreadId: 9,
					},
				},
				trust: { signatureVerified: true },
			},
		});
	});

	it("builds Bot API delivery effects", async () => {
		const effects = await connector.deliver?.(
			{
				id: "cdl_1",
				orgId: "org_1",
				connectionId: "chn_1",
				sessionId: "ssn_1",
				replyRoute: {
					kind: "provider_http",
					connectionId: "chn_1",
					subject: "123",
					data: { provider: "telegram", chatId: "123", messageThreadId: 9 },
				},
				payload: "reply text",
				attemptCount: 0,
			},
			ctx({ botToken: "bot-token" }),
		);

		expect(effects?.[0]).toMatchObject({
			type: "fetch",
			request: {
				url: "https://api.telegram.org/botbot-token/sendMessage",
				method: "POST",
				headers: { "Content-Type": "application/json" },
			},
		});
		expect(
			JSON.parse(effects?.[0].type === "fetch" ? (effects[0].request.body ?? "{}") : "{}"),
		).toEqual({
			chat_id: "123",
			message_thread_id: 9,
			text: "reply text",
		});
	});
});
