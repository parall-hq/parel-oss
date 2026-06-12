import type { ConnectorContext, ConnectorEffect, WebSocketFrame } from "@parel/plugin-sdk";
import { envelopeFromSocketFrame, slackPayload } from "./normalize.js";
import { parseJsonFrame, stringAt, textFrame } from "./utils.js";

// Provider ref: https://docs.slack.dev/apis/events-api/using-socket-mode/
export function handleSlackSocketMessage(
	frame: WebSocketFrame,
	ctx: ConnectorContext,
): ConnectorEffect[] {
	const text = textFrame(frame);
	const body = parseJsonFrame(text);
	const envelopeId = stringAt(body, "envelope_id");
	const ack: ConnectorEffect[] = envelopeId
		? [{ type: "send", data: JSON.stringify({ envelope_id: envelopeId }) }]
		: [];
	const type = stringAt(body, "type");
	if (type === "hello") return [];
	if (type === "disconnect") {
		return [...ack, { type: "close", reason: stringAt(body, "reason") }];
	}
	if (!slackPayload(body) && type !== "events_api") return ack;
	return [...ack, { type: "emitEvent", event: envelopeFromSocketFrame(ctx, body, text) }];
}
