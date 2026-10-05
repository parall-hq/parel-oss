import { describe, expect, test } from "vitest";
import {
	ChatPrinter,
	createTurnCollector,
	preview,
	type SessionFrame,
	type TurnEnd,
} from "./session-frames.js";

function collect(frames: SessionFrame[]) {
	const collector = createTurnCollector();
	let end: TurnEnd | undefined;
	for (const frame of frames) {
		end = collector.handle(frame);
		if (end) break;
	}
	return { end, output: collector.output };
}

describe("createTurnCollector", () => {
	test("collects text, tool calls and tool result content until turn_end", () => {
		const { end, output } = collect([
			{ type: "message_ack", status: "accepted", inputId: "in_1", turnId: "trn_1" },
			{ type: "text", text: "Let me look. " },
			{ type: "tool_call", callId: "c1", name: "read_file", arguments: { path: "a.txt" } },
			{ type: "tool_result", callId: "c1", name: "read_file", content: "hello", isError: false },
			{ type: "text", text: "It says hello." },
			{ type: "turn_end", state: {} },
		]);
		expect(end).toEqual({ status: "completed" });
		expect(output.response).toBe("Let me look. It says hello.");
		expect(output.tool_calls).toEqual([{ name: "read_file", arguments: { path: "a.txt" } }]);
		expect(output.messages).toEqual([
			{ role: "tool_result", content: "hello" },
			{ role: "assistant", content: "Let me look. It says hello." },
		]);
	});

	test("ends on a slash command that ran without a turn (no turn_end follows)", () => {
		// Inline command: command_result arrives first, then the executed ack.
		const { end, output } = collect([
			{ type: "command_result", inputId: "in_1", name: "help", args: "", ok: true, reply: "/help" },
			{ type: "message_ack", status: "executed" },
		]);
		expect(end).toEqual({ status: "completed" });
		expect(output.response).toBe("/help");
	});

	test("ends on an executed ack alone", () => {
		const { end, output } = collect([
			{
				type: "message_ack",
				status: "executed",
				command: { name: "compact", args: "" },
				result: { ok: true, reply: "Compacted." },
			},
		]);
		expect(end).toEqual({ status: "completed" });
		expect(output.response).toBe("Compacted.");
	});

	test("reports a failed command as an error", () => {
		const { end } = collect([
			{ type: "command_result", name: "compact", ok: false, error: "boom", code: "command_failed" },
		]);
		expect(end).toEqual({ status: "error", error: "/compact failed: boom" });
	});

	test("keeps waiting for the turn a command opened", () => {
		const { end, output } = collect([
			{ type: "message_ack", status: "accepted", turnId: "trn_1", command: { name: "plan" } },
			{ type: "command_result", name: "plan", ok: true, turnId: "trn_1" },
			{ type: "text", text: "Planning." },
			{ type: "turn_end", state: {} },
		]);
		expect(end).toEqual({ status: "completed" });
		expect(output.response).toBe("Planning.");
	});

	test("ends on an error frame", () => {
		expect(collect([{ type: "error", error: "budget exceeded" }]).end).toEqual({
			status: "error",
			error: "budget exceeded",
		});
	});
});

describe("ChatPrinter", () => {
	const plain = { green: (s: string) => s, dim: (s: string) => s, red: (s: string) => s };
	const printed = (run: (p: ChatPrinter) => void) => {
		let out = "";
		run(new ChatPrinter((text) => (out += text), plain));
		return out;
	};

	test("prints tool lines on their own lines and resumes text on a new line", () => {
		const out = printed((p) => {
			p.text("Checking");
			p.text(" now.");
			p.toolCall({ type: "tool_call", name: "ls", arguments: { path: "." } });
			p.toolResult({ type: "tool_result", name: "ls", content: "a.txt\nb.txt", isError: false });
			p.text("Two files.");
			p.endTurn();
		});
		expect(out).toBe(
			'▸ Checking now.\n  [tool] ls({"path":"."})\n  [result] a.txt b.txt\n▸ Two files.\n\n',
		);
	});

	test("prints the result content, not the whole frame, and marks errors", () => {
		const out = printed((p) =>
			p.toolResult({ type: "tool_result", callId: "c1", content: "not found", isError: true }),
		);
		expect(out).toBe("  [result: error] not found\n");
	});

	test("cuts long results to one short line", () => {
		const out = printed((p) => p.toolResult({ type: "tool_result", content: "x".repeat(500) }));
		expect(out).toBe(`  [result] ${"x".repeat(99)}…\n`);
	});
});

describe("preview", () => {
	test("collapses whitespace and cuts at the limit", () => {
		expect(preview("  a\n\n b  ", 10)).toBe("a b");
		expect(preview("abcdef", 4)).toBe("abc…");
	});
});
