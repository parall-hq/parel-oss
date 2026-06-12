import type { ChannelEnvelope, ConnectorContext } from "@parel/plugin-sdk";
import { getPath, stringAt } from "./utils.js";

// Provider refs:
// - Socket Mode envelopes: https://docs.slack.dev/apis/events-api/using-socket-mode/
// - Events API payloads: https://docs.slack.dev/apis/events-api/
// - Interaction payloads: https://docs.slack.dev/reference/interaction-payloads/
// - Slash command payloads: https://docs.slack.dev/interactivity/implementing-slash-commands/
export function slackPayload(body: unknown): unknown {
	return getPath(body, "payload");
}

function slackEventType(body: unknown): string {
	const bodyType = stringAt(body, "type") ?? "message";
	if (bodyType === "events_api") {
		const type = stringAt(body, "payload.event.type") ?? stringAt(body, "payload.type");
		return type ? `slack.${type}` : "slack.event";
	}
	if (bodyType === "slash_commands") return "slack.command";
	if (bodyType === "interactive") {
		const interactiveType = stringAt(body, "payload.type");
		return interactiveType ? `slack.interactive.${interactiveType}` : "slack.interactive";
	}
	return `slack.${bodyType}`;
}

function slackEventId(body: unknown, fallback: string): string {
	return (
		stringAt(body, "payload.event_id") ??
		stringAt(body, "envelope_id") ??
		stringAt(body, "payload.trigger_id") ??
		fallback
	);
}

function slackChannel(body: unknown): string | undefined {
	return (
		stringAt(body, "payload.event.channel") ??
		stringAt(body, "payload.channel.id") ??
		stringAt(body, "payload.channel_id") ??
		stringAt(body, "payload.container.channel_id")
	);
}

function slackThreadTs(body: unknown): string | undefined {
	return (
		stringAt(body, "payload.event.thread_ts") ??
		stringAt(body, "payload.event.ts") ??
		stringAt(body, "payload.message.thread_ts") ??
		stringAt(body, "payload.message.ts") ??
		stringAt(body, "payload.container.thread_ts") ??
		stringAt(body, "payload.container.message_ts")
	);
}

function slackSubject(body: unknown): string | undefined {
	const channel = slackChannel(body);
	if (!channel) return stringAt(body, "payload.user.id") ?? stringAt(body, "payload.user_id");
	const threadTs = slackThreadTs(body);
	return threadTs ? `${channel}:${threadTs}` : channel;
}

function slackActor(body: unknown): unknown {
	return (
		getPath(body, "payload.event.user") ??
		getPath(body, "payload.event.bot_id") ??
		getPath(body, "payload.user") ??
		getPath(body, "payload.user_id")
	);
}

function responseUrl(body: unknown): string | undefined {
	return stringAt(body, "payload.response_url");
}

export function envelopeFromSocketFrame(
	ctx: ConnectorContext,
	body: unknown,
	fallback: string,
): ChannelEnvelope {
	const channel = slackChannel(body);
	const threadTs = slackThreadTs(body);
	const subject = slackSubject(body);
	return {
		id: slackEventId(body, fallback),
		source: "slack.socket",
		type: slackEventType(body),
		subject,
		actor: slackActor(body),
		data: slackPayload(body) ?? body,
		replyRoute: {
			kind: "provider_http",
			connectionId: ctx.connectionId,
			subject,
			data: {
				provider: "slack",
				channel,
				threadTs,
				responseUrl: responseUrl(body),
				teamId: stringAt(body, "payload.team_id") ?? stringAt(body, "payload.team.id"),
			},
		},
		trust: { connectionAuthenticated: true },
	};
}
