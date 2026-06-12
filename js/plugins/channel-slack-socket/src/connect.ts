import type { ConnectorContext, ConnectRequest } from "@parel/plugin-sdk";
import { ChannelConnectorError } from "./error.js";
import { isRecord, stringAt } from "./utils.js";

// Provider refs:
// - apps.connections.open: https://docs.slack.dev/reference/methods/apps.connections.open/
// - connections:write scope: https://docs.slack.dev/reference/scopes/connections.write/
export async function openSlackSocketModeConnection(
	ctx: ConnectorContext,
): Promise<ConnectRequest> {
	if (typeof ctx.config.url === "string" && ctx.config.url.length > 0) {
		return { url: ctx.config.url };
	}
	const appToken = ctx.secrets.appToken;
	if (!appToken) throw new ChannelConnectorError("Slack appToken secret is not configured", 503);

	const response = await fetch("https://slack.com/api/apps.connections.open", {
		method: "POST",
		headers: {
			Authorization: `Bearer ${appToken}`,
			"Content-Type": "application/json; charset=utf-8",
		},
		body: "{}",
	});
	const body = (await response.json().catch(() => ({}))) as unknown;
	const url = stringAt(body, "url");
	if (!response.ok || !isRecord(body) || body.ok !== true || !url) {
		const error = stringAt(body, "error") ?? `http_${response.status}`;
		throw new ChannelConnectorError(`Slack apps.connections.open failed: ${error}`, 502);
	}
	return { url };
}
