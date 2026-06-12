import type { ConnectorContext } from "@parel/plugin-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import connector from "./index.js";

function ctx(secrets: Record<string, string> = {}, config: Record<string, unknown> = {}) {
	return {
		orgId: "org_1",
		connectionId: "chn_1",
		pluginName: "@parel/channel-slack-socket",
		config,
		secrets,
		now: () => 123,
	} satisfies ConnectorContext;
}

describe("@parel/channel-slack-socket", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("opens Slack Socket Mode connections", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(JSON.stringify({ ok: true, url: "wss://slack.test/socket" }))),
		);

		await expect(connector.connect?.(ctx({ appToken: "xapp-token" }))).resolves.toEqual({
			url: "wss://slack.test/socket",
		});
		expect(fetch).toHaveBeenCalledWith(
			"https://slack.com/api/apps.connections.open",
			expect.objectContaining({
				method: "POST",
				headers: expect.objectContaining({ Authorization: "Bearer xapp-token" }),
			}),
		);
	});

	it("acks and normalizes Events API envelopes", async () => {
		const effects = await connector.onMessage?.(
			{
				data: JSON.stringify({
					envelope_id: "env_1",
					type: "events_api",
					payload: {
						event_id: "Ev123",
						team_id: "T1",
						event: {
							type: "message",
							channel: "C1",
							user: "U1",
							ts: "1710000000.000100",
							text: "hello",
						},
					},
				}),
			},
			ctx(),
		);

		expect(effects?.[0]).toEqual({
			type: "send",
			data: JSON.stringify({ envelope_id: "env_1" }),
		});
		expect(effects?.[1]).toMatchObject({
			type: "emitEvent",
			event: {
				id: "Ev123",
				source: "slack.socket",
				type: "slack.message",
				subject: "C1:1710000000.000100",
				actor: "U1",
				replyRoute: {
					kind: "provider_http",
					connectionId: "chn_1",
					data: {
						provider: "slack",
						channel: "C1",
						threadTs: "1710000000.000100",
						teamId: "T1",
					},
				},
			},
		});
	});

	it("builds Slack Web API delivery effects", async () => {
		const effects = await connector.deliver?.(
			{
				id: "cdl_1",
				orgId: "org_1",
				connectionId: "chn_1",
				sessionId: "ssn_1",
				replyRoute: {
					kind: "provider_http",
					connectionId: "chn_1",
					subject: "C1:1710000000.000100",
					data: { provider: "slack", channel: "C1", threadTs: "1710000000.000100" },
				},
				payload: "reply text",
				attemptCount: 0,
			},
			ctx({ botToken: "xoxb-token" }),
		);

		expect(effects?.[0]).toMatchObject({
			type: "fetch",
			request: {
				url: "https://slack.com/api/chat.postMessage",
				method: "POST",
				headers: {
					Authorization: "Bearer xoxb-token",
					"Content-Type": "application/json; charset=utf-8",
				},
			},
		});
		expect(
			JSON.parse(effects?.[0].type === "fetch" ? (effects[0].request.body ?? "{}") : "{}"),
		).toEqual({
			channel: "C1",
			thread_ts: "1710000000.000100",
			text: "reply text",
		});
	});
});
