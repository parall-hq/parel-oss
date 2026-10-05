/**
 * Reading the session WebSocket (`/sessions/:id/ws`): the frames a turn or a
 * slash command streams back, turned into a result (`send`, `run`, `try`) or into
 * terminal lines (`chat`). No I/O here, so it is unit testable.
 */

export interface SessionFrame {
	type: string;
	[key: string]: unknown;
}

/** Reply text a frame streams, or "" when it carries none. */
export function frameText(frame: SessionFrame): string {
	switch (frame.type) {
		case "text":
		case "message":
		case "content_block_delta":
		case "delta": {
			const chunk = frame.text ?? frame.delta ?? frame.content;
			return typeof chunk === "string" ? chunk : "";
		}
		default:
			return "";
	}
}

/** A tool result's output, which the runtime sends as `content`. */
export function toolResultText(frame: SessionFrame): string {
	return typeof frame.content === "string" ? frame.content : "";
}

/** One line of at most `max` characters: whitespace collapsed, the rest cut off. */
export function preview(text: string, max: number): string {
	const line = text.replace(/\s+/g, " ").trim();
	return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

export interface CommandOutcome {
	name: string;
	ok: boolean;
	reply?: string;
	error?: string;
}

/**
 * The outcome of a slash command that finished without opening a turn, or
 * undefined for any other frame. Such a command never sends `turn_end`: it ends
 * with `command_result`, and with a `message_ack` of status "executed" when it
 * ran right away. A command that opened a turn carries that turn's id and ends
 * with the turn's `turn_end`, like any message.
 */
export function finishedCommand(frame: SessionFrame): CommandOutcome | undefined {
	if (frame.type === "command_result" && !frame.turnId) return commandOutcome(frame, frame);
	if (frame.type === "message_ack" && frame.status === "executed" && isRecord(frame.result)) {
		return commandOutcome(isRecord(frame.command) ? frame.command : {}, frame.result);
	}
	return undefined;
}

function commandOutcome(
	command: Record<string, unknown>,
	result: Record<string, unknown>,
): CommandOutcome {
	return {
		name: String(command.name ?? ""),
		ok: result.ok === true,
		...(typeof result.reply === "string" ? { reply: result.reply } : {}),
		...(typeof result.error === "string" ? { error: result.error } : {}),
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface TurnOutput {
	response: string;
	messages: { role: string; content: string }[];
	tool_calls: { name: string; arguments: unknown }[];
}

export type TurnEnd =
	| { status: "completed"; error?: undefined }
	| { status: "error"; error: string };

/**
 * Collects one turn's output from its frames. `handle` returns how the wait ends
 * once a frame ends it: `turn_end`, an `error`, or a slash command that finished
 * without a turn (its reply becomes the response).
 */
export function createTurnCollector(): {
	output: TurnOutput;
	handle(frame: SessionFrame): TurnEnd | undefined;
} {
	const output: TurnOutput = { response: "", messages: [], tool_calls: [] };
	return {
		output,
		handle(frame) {
			const command = finishedCommand(frame);
			if (command) {
				if (!command.ok)
					return {
						status: "error",
						error: `/${command.name} failed: ${command.error ?? "unknown"}`,
					};
				output.response = command.reply ?? "";
				return { status: "completed" };
			}
			switch (frame.type) {
				case "tool_call":
					output.tool_calls.push({
						name: typeof frame.name === "string" ? frame.name : "unknown",
						arguments: frame.arguments ?? frame.input ?? {},
					});
					return undefined;
				case "tool_result":
					output.messages.push({ role: "tool_result", content: toolResultText(frame) });
					return undefined;
				case "turn_end":
					if (output.response)
						output.messages.push({ role: "assistant", content: output.response });
					return { status: "completed" };
				case "error":
					return {
						status: "error",
						error: String(frame.error ?? frame.message ?? frame.reason ?? "unknown"),
					};
				default:
					output.response += frameText(frame);
					return undefined;
			}
		},
	};
}

const TOOL_PREVIEW_CHARS = 100;

interface ChatStyle {
	green(s: string): string;
	dim(s: string): string;
	red(s: string): string;
}

/**
 * Prints a chat's streamed frames: reply text after a "▸ " marker, tool calls and
 * their results as short `[tool]` / `[result]` lines. It tracks whether the
 * cursor is mid-line, so every tool line, and any reply text after one, starts
 * on its own line.
 */
export class ChatPrinter {
	private midLine = false;
	private inReply = false;

	constructor(
		private readonly write: (text: string) => void,
		private readonly style: ChatStyle,
	) {}

	text(chunk: string): void {
		if (!chunk) return;
		if (!this.inReply) {
			this.endLine();
			this.write(this.style.green("▸ "));
			this.inReply = true;
		}
		this.write(chunk);
		this.midLine = !chunk.endsWith("\n");
	}

	toolCall(frame: SessionFrame): void {
		const name = typeof frame.name === "string" ? frame.name : "tool";
		const args = JSON.stringify(frame.arguments ?? frame.input ?? {});
		this.line(this.style.dim(`  [tool] ${name}(${preview(args, TOOL_PREVIEW_CHARS)})`));
	}

	toolResult(frame: SessionFrame): void {
		const text = preview(toolResultText(frame), TOOL_PREVIEW_CHARS);
		this.line(
			frame.isError === true
				? this.style.red(`  [result: error] ${text}`)
				: this.style.dim(`  [result] ${text}`),
		);
	}

	/** A line of its own, after the reply text so far. */
	line(text: string): void {
		this.endLine();
		this.write(`${text}\n`);
		this.inReply = false;
	}

	/** Ends the turn's output with a blank line, ready for the prompt. */
	endTurn(): void {
		this.endLine();
		this.write("\n");
		this.inReply = false;
	}

	private endLine(): void {
		if (!this.midLine) return;
		this.write("\n");
		this.midLine = false;
	}
}
