import type { WebSocketFrame } from "@parel/plugin-sdk";
import { ChannelConnectorError } from "./error.js";

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function stringValue(value: unknown): string | undefined {
	if (typeof value === "string" && value.length > 0) return value;
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	return undefined;
}

export function getPath(input: unknown, path: string): unknown {
	let cur = input;
	for (const part of path.split(".")) {
		if (!part) continue;
		if (!isRecord(cur)) return undefined;
		cur = cur[part];
	}
	return cur;
}

export function stringAt(input: unknown, path: string): string | undefined {
	return stringValue(getPath(input, path));
}

export function textFrame(frame: WebSocketFrame): string {
	return typeof frame.data === "string" ? frame.data : new TextDecoder().decode(frame.data);
}

export function parseJsonFrame(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		throw new ChannelConnectorError("Slack Socket Mode frame must be JSON", 400);
	}
}
