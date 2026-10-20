import type {
	CommandContext,
	CommandHandler,
	HookHandler,
	LifecycleEventType,
	Message,
	ModelCallParams,
	ModelGatewayAccess,
	PluginContext,
	SessionStore,
	TokenUsage,
	TranscriptReader,
} from "@parel/plugin-sdk";
import { describe, expect, it } from "vitest";
import pkg from "../package.json" with { type: "json" };
import manifest from "../parel.plugin.json" with { type: "json" };
import memoryPlugin from "./index.js";

function makeStore(): SessionStore {
	const map = new Map<string, unknown>();
	return {
		async get<T>(key: string) {
			return (map.has(key) ? (map.get(key) as T) : null) as T | null;
		},
		async set<T>(key: string, value: T) {
			map.set(key, value);
		},
		async delete(key: string) {
			map.delete(key);
		},
		async list(prefix?: string) {
			return [...map.keys()].filter((k) => !prefix || k.startsWith(prefix));
		},
	};
}

/** A summary model that answers `reply` (or throws it), recording each call. */
function fakeModel(
	reply: string | Error,
	prompts: string[] = [],
	calls: ModelCallParams[] = [],
): ModelGatewayAccess {
	return {
		async *chat(params) {
			calls.push(params);
			prompts.push((params.messages[0].parts[0] as { text: string }).text);
			if (reply instanceof Error) throw reply;
			yield { type: "text_delta" as const, text: reply };
			yield { type: "text_end" as const };
		},
		capabilities() {
			return {
				modelId: "fake",
				provider: "fake",
				maxContextTokens: 1000,
				toolCalling: false,
				parallelToolCalls: false,
				streaming: true,
				vision: false,
				thinking: false,
			};
		},
		listProviders() {
			return ["fake"];
		},
	};
}

function makeHarness(opts: {
	config?: Record<string, unknown>;
	model?: ModelGatewayAccess;
	store?: SessionStore;
}) {
	const hooks = new Map<string, HookHandler<LifecycleEventType>>();
	const commands = new Map<string, CommandHandler>();
	const logs: { level: string; message: string }[] = [];
	const record = (level: string) => (message: string) => logs.push({ level, message });
	const store = opts.store ?? makeStore();
	const ctx = {
		config: opts.config ?? {},
		model: opts.model ?? fakeModel("SUMMARY"),
		store,
		inputs: { drain: () => [], peek: () => [], push() {} },
		log: {
			debug: record("debug"),
			info: record("info"),
			warn: record("warn"),
			error: record("error"),
		},
		hook(event: string, handler: HookHandler<LifecycleEventType>) {
			hooks.set(event, handler);
		},
		tool() {},
		command(definition: { name: string }, handler: CommandHandler) {
			commands.set(definition.name, handler);
		},
		provide() {},
		require() {
			throw new Error("not provided");
		},
		interrupt() {},
	} as unknown as PluginContext;
	const fire = (event: string, hookCtx: Record<string, unknown> = {}) =>
		hooks.get(event)?.(hookCtx as never);
	return { ctx, hooks, commands, store, logs, fire };
}

function msg(role: Message["role"], text: string): Message {
	return { role, parts: [{ type: "text", text }] };
}

// Each message is 70 characters, an estimated 18 tokens.
function bulkMessages(n: number, filler: string): Message[] {
	return Array.from({ length: n }, (_, i) =>
		msg(i % 2 === 0 ? "user" : "assistant", `${filler} message ${i}`),
	);
}

function toolCall(id: string, name = "bash"): Message {
	return {
		role: "assistant",
		parts: [{ type: "tool_call", toolCall: { id, name, arguments: {} } }],
	};
}

function toolResult(id: string, content: string): Message {
	return { role: "tool", parts: [{ type: "tool_result", toolCallId: id, content }] };
}

/** A transcript reader over a path that tests can append to. */
function pathReader(path: Message[]): TranscriptReader {
	return {
		generation: 0,
		async read(range) {
			return path.filter((message) => (message.seq ?? 0) >= (range?.fromSeq ?? 1));
		},
	};
}

function withSeqs(messages: Message[], first = 1): Message[] {
	return messages.map((message, index) => ({ ...message, seq: first + index }));
}

function usage(inputTokens: number, extra: Partial<TokenUsage> = {}) {
	return { modelResponse: { usage: { inputTokens, outputTokens: 10, ...extra } } };
}

const turn = (turnId: string) => ({ turn: { turnId, inputIds: [], absorbed: [] } });

// threshold = 100 × 0.8 = 80 tokens; the kept window is ~30 tokens (two bulk messages).
const SMALL = { max_context_tokens: 100, keep_recent_tokens: 30 };

const contextBuild = "context:build";
const modelAfter = "model:after";
const stepEnd = "step:end";
const turnEnd = "turn:end";

describe("@parel/memory-rolling-summary", () => {
	it("does nothing while under the threshold", async () => {
		const prompts: string[] = [];
		const h = makeHarness({
			config: { max_context_tokens: 100_000 },
			model: fakeModel("SUMMARY", prompts),
		});
		await memoryPlugin.setup(h.ctx);

		const built = await h.fire(contextBuild, { system: "SYS", messages: [msg("user", "hi")] });
		expect(built).toBeUndefined(); // no summary yet → no mutation

		await h.fire(turnEnd);
		expect(prompts).toHaveLength(0); // never called the model
		expect(await h.store.get("rolling_summary")).toBeNull();
	});

	it("compacts older messages into a summary once the window is large", async () => {
		const prompts: string[] = [];
		const h = makeHarness({ config: SMALL, model: fakeModel("ROLLED UP", prompts) });
		await memoryPlugin.setup(h.ctx);

		await h.fire(contextBuild, { system: "SYS", messages: bulkMessages(8, "x".repeat(60)) });
		await h.fire(turnEnd);

		const state = (await h.store.get("rolling_summary")) as {
			summary: string;
			summarizedUptoSeq: number;
		} | null;
		expect(state?.summary).toBe("ROLLED UP");
		// 8 messages, ~30 tokens kept → the last 2 stay, the first 6 fold (coordinate 6).
		expect(state?.summarizedUptoSeq).toBe(6);
		expect(prompts).toHaveLength(1);
		expect(prompts[0]).toContain("message 0"); // oldest folded
		expect(prompts[0]).not.toContain("message 7"); // recent kept verbatim
	});

	it("prunes the summarized prefix and injects the summary on the next build", async () => {
		const h = makeHarness({ config: SMALL, model: fakeModel("ROLLED UP") });
		await memoryPlugin.setup(h.ctx);

		const messages = bulkMessages(8, "x".repeat(60));
		await h.fire(contextBuild, { system: "SYS", messages });
		await h.fire(turnEnd);

		const out = (await h.fire(contextBuild, { system: "SYS", messages })) as {
			mutations: { system: string; messages: Message[] };
		};
		expect(out.mutations.messages).toHaveLength(2); // only the recent kept
		expect(out.mutations.system).toContain("<conversation-summary>");
		expect(out.mutations.system).toContain("ROLLED UP");
	});

	it("rolls forward: the prior summary is folded into the next one", async () => {
		const prompts: string[] = [];
		const h = makeHarness({ config: SMALL, model: fakeModel("SUMMARY v2", prompts) });
		await memoryPlugin.setup(h.ctx);

		await h.fire(contextBuild, { system: "SYS", messages: bulkMessages(8, "x".repeat(60)) });
		await h.fire(turnEnd);
		// Seed a known prior summary in the LEGACY count-based shape, then grow the
		// window and compact again — the count reads as a path coordinate.
		await h.store.set("rolling_summary", { summary: "PRIOR SUMMARY", summarizedCount: 6 });
		await h.fire(contextBuild, { system: "SYS", messages: bulkMessages(16, "x".repeat(60)) });
		await h.fire(turnEnd);

		expect(prompts.at(-1)).toContain("PRIOR SUMMARY"); // folded the existing summary
		const state = (await h.store.get("rolling_summary")) as { summarizedUptoSeq: number };
		expect(state.summarizedUptoSeq).toBe(14); // 16 minus the 2 kept
	});

	it("keeps prior state when the model returns nothing", async () => {
		const h = makeHarness({ config: SMALL, model: fakeModel("   ") }); // trimmed empty
		await memoryPlugin.setup(h.ctx);
		await h.fire(contextBuild, { system: "SYS", messages: bulkMessages(8, "x".repeat(60)) });
		await h.fire(turnEnd);
		expect(await h.store.get("rolling_summary")).toBeNull(); // not advanced
		expect(h.logs.at(-1)?.message).toContain("returned no text");
	});

	it("does not leak hidden reasoning into the summary", async () => {
		const prompts: string[] = [];
		const h = makeHarness({ config: SMALL, model: fakeModel("ROLLED UP", prompts) });
		await memoryPlugin.setup(h.ctx);

		const messages: Message[] = [
			{
				role: "assistant",
				parts: [
					{ type: "text", text: "x".repeat(200) },
					{ type: "reasoning", text: "SECRET_CHAIN_OF_THOUGHT", visibility: "hidden" },
				],
			},
			...bulkMessages(7, "x".repeat(60)),
		];
		await h.fire(contextBuild, { system: "SYS", messages });
		await h.fire(turnEnd);

		expect(prompts).toHaveLength(1);
		expect(prompts[0]).not.toContain("SECRET_CHAIN_OF_THOUGHT");
	});

	it("represents attachments with a placeholder instead of dropping them silently", async () => {
		const prompts: string[] = [];
		const h = makeHarness({ config: SMALL, model: fakeModel("ROLLED UP", prompts) });
		await memoryPlugin.setup(h.ctx);

		const messages: Message[] = [
			{
				role: "user",
				parts: [
					{ type: "text", text: "x".repeat(200) },
					{
						type: "file",
						data: "BASE64DATA",
						mediaType: "application/pdf",
						filename: "report.pdf",
					},
				],
			},
			...bulkMessages(7, "x".repeat(60)),
		];
		await h.fire(contextBuild, { system: "SYS", messages });
		await h.fire(turnEnd);

		expect(prompts[0]).toContain("[file report.pdf]"); // attachment noted
		expect(prompts[0]).not.toContain("BASE64DATA"); // raw payload not leaked
	});

	it("on a lazy host (no pushed messages) it reads only the tail through hookCtx.transcript", async () => {
		const prompts: string[] = [];
		const h = makeHarness({ config: SMALL, model: fakeModel("ROLLED UP", prompts) });
		await memoryPlugin.setup(h.ctx);
		// A pointer-forked path: seqs continue from a parent (101..108).
		const path = withSeqs(bulkMessages(8, "x".repeat(60)), 101);
		const reads: { fromSeq?: number }[] = [];
		const transcript = {
			generation: 0,
			async read(range?: { fromSeq?: number }) {
				reads.push(range ?? {});
				return path.filter((m) => (m.seq ?? 0) >= (range?.fromSeq ?? 1));
			},
		};
		// First build: nothing summarized → the whole path is supplied as the window.
		const first = (await h.fire(contextBuild, { system: "SYS", transcript })) as {
			mutations: { messages: Message[] };
		};
		expect(first.mutations.messages).toHaveLength(8);
		expect(reads.at(-1)).toEqual({ fromSeq: 1 });
		await h.fire(turnEnd);
		const state = (await h.store.get("rolling_summary")) as { summarizedUptoSeq: number };
		expect(state.summarizedUptoSeq).toBe(106); // 101..106 folded, 107/108 kept
		expect(prompts[0]).toContain("message 0");
		expect(prompts[0]).not.toContain("message 7");
		// Second build: only the tail past the mark is read and returned.
		const second = (await h.fire(contextBuild, { system: "SYS", transcript })) as {
			mutations: { system: string; messages: Message[] };
		};
		expect(reads.at(-1)).toEqual({ fromSeq: 107 });
		expect(second.mutations.messages.map((m) => m.seq)).toEqual([107, 108]);
		expect(second.mutations.system).toContain("ROLLED UP");
	});

	it("also rolls forward at step:end so a long turn cannot blow the window", async () => {
		const prompts: string[] = [];
		const h = makeHarness({ config: SMALL, model: fakeModel("MID-TURN", prompts) });
		await memoryPlugin.setup(h.ctx);
		await h.fire(contextBuild, { system: "SYS", messages: bulkMessages(8, "x".repeat(60)) });
		await h.fire(stepEnd);
		expect(prompts).toHaveLength(1);
		const state = (await h.store.get("rolling_summary")) as { summarizedUptoSeq: number };
		expect(state.summarizedUptoSeq).toBe(6);
	});

	it("takes the budget from the adapter's advertised window when not configured", async () => {
		const prompts: string[] = [];
		// fakeModel advertises maxContextTokens 1000 → threshold 800 tokens: 8 × 18
		// estimated tokens stays under it, so nothing compacts without a config override.
		const h = makeHarness({ config: {}, model: fakeModel("ROLLED UP", prompts) });
		await memoryPlugin.setup(h.ctx);
		await h.fire(contextBuild, { system: "SYS", messages: bulkMessages(8, "x".repeat(60)) });
		await h.fire(turnEnd);
		expect(prompts).toHaveLength(0);
	});

	it("ships no manifest version of its own to drift from package.json", () => {
		expect((manifest as { version?: string }).version ?? pkg.version).toBe(pkg.version);
	});
});

describe("trigger: the real input size", () => {
	// Three short messages: an estimated ~6 tokens, far under the 80-token threshold.
	const short = () => [msg("user", "hello there"), msg("assistant", "hi"), msg("user", "go on")];

	it("folds when the last call's reported input (input + cache read + cache write) reaches the threshold", async () => {
		const prompts: string[] = [];
		const h = makeHarness({
			config: { max_context_tokens: 100, keep_recent_tokens: 2 },
			model: fakeModel("ROLLED UP", prompts),
		});
		await memoryPlugin.setup(h.ctx);
		await h.fire(contextBuild, { system: "SYS", messages: short() });
		await h.fire(modelAfter, usage(40, { cacheReadTokens: 30, cacheWriteTokens: 10 }));
		await h.fire(stepEnd);
		expect(prompts).toHaveLength(1); // 80 reported ≥ 80, though the text estimates ~6
	});

	it("does not fold when the reported input is under the threshold, whatever the estimate says", async () => {
		const prompts: string[] = [];
		const h = makeHarness({ config: SMALL, model: fakeModel("ROLLED UP", prompts) });
		await memoryPlugin.setup(h.ctx);
		await h.fire(contextBuild, { system: "SYS", messages: bulkMessages(8, "x".repeat(60)) });
		await h.fire(modelAfter, usage(50));
		await h.fire(stepEnd);
		expect(prompts).toHaveLength(0); // the estimate (~144) would have folded
	});

	it("adds what the transcript gained since the last call", async () => {
		const prompts: string[] = [];
		const h = makeHarness({ config: SMALL, model: fakeModel("ROLLED UP", prompts) });
		await memoryPlugin.setup(h.ctx);
		const path = withSeqs(bulkMessages(4, "x".repeat(60)));
		const transcript = pathReader(path);
		await h.fire(contextBuild, { system: "SYS", transcript });
		await h.fire(modelAfter, usage(70)); // the call saw seq 1..4: under the line
		await h.fire(stepEnd, { transcript });
		expect(prompts).toHaveLength(0);
		// The step's tool call and result land after the call: 70 + ~22 estimated ≥ 80.
		path.push(...withSeqs([toolCall("t1"), toolResult("t1", "y".repeat(60))], 5));
		await h.fire(stepEnd, { transcript });
		expect(prompts).toHaveLength(1);
	});

	it("falls back to the estimate when a call reports no usage", async () => {
		const prompts: string[] = [];
		const h = makeHarness({ config: SMALL, model: fakeModel("ROLLED UP", prompts) });
		await memoryPlugin.setup(h.ctx);
		await h.fire(contextBuild, { system: "SYS", messages: bulkMessages(8, "x".repeat(60)) });
		await h.fire(modelAfter, usage(50)); // an earlier call…
		await h.fire(modelAfter, usage(0)); // …must not stand in for one that reported nothing
		await h.fire(stepEnd);
		expect(prompts).toHaveLength(1);
	});

	it("drops the measurement once it folds, so turn:end does not fold again on a stale number", async () => {
		const prompts: string[] = [];
		const h = makeHarness({
			config: { max_context_tokens: 100, keep_recent_tokens: 2 },
			model: fakeModel("ROLLED UP", prompts),
		});
		await memoryPlugin.setup(h.ctx);
		await h.fire(contextBuild, { system: "SYS", messages: short() });
		await h.fire(modelAfter, usage(90));
		await h.fire(stepEnd);
		await h.fire(turnEnd);
		expect(prompts).toHaveLength(1);
		expect(await h.store.get("rolling_summary_last_call")).toBeNull();
	});

	it("estimates CJK text at about a token per character", async () => {
		const prompts: string[] = [];
		const h = makeHarness({ config: SMALL, model: fakeModel("已压缩", prompts) });
		await memoryPlugin.setup(h.ctx);
		// 4 × 30 Chinese characters ≈ 120 tokens (a flat chars/4 would say 32).
		const messages = Array.from({ length: 4 }, (_, i) =>
			msg(i % 2 === 0 ? "user" : "assistant", "压缩".repeat(15)),
		);
		await h.fire(contextBuild, { system: "SYS", messages });
		await h.fire(turnEnd);
		expect(prompts).toHaveLength(1);
	});
});

describe("summary call", () => {
	it("leaves the output limit to the host's default (the model's own)", async () => {
		const calls: ModelCallParams[] = [];
		const h = makeHarness({ config: SMALL, model: fakeModel("ROLLED UP", [], calls) });
		await memoryPlugin.setup(h.ctx);
		await h.fire(contextBuild, { system: "SYS", messages: bulkMessages(8, "x".repeat(60)) });
		await h.fire(turnEnd);
		expect(calls).toHaveLength(1);
		expect(calls[0].maxTokens).toBeUndefined();
	});

	it("truncates long tool results, tool arguments and text in the summarizer's input", async () => {
		const prompts: string[] = [];
		const h = makeHarness({ config: SMALL, model: fakeModel("ROLLED UP", prompts) });
		await memoryPlugin.setup(h.ctx);
		const messages: Message[] = [
			msg("user", "t".repeat(7_000)),
			{
				role: "assistant",
				parts: [
					{
						type: "tool_call",
						toolCall: { id: "t1", name: "write", arguments: { body: "a".repeat(3_000) } },
					},
				],
			},
			toolResult("t1", "r".repeat(5_000)),
			...bulkMessages(2, "x".repeat(60)),
		];
		await h.fire(contextBuild, { system: "SYS", messages });
		await h.fire(turnEnd);

		expect(prompts).toHaveLength(1);
		expect(prompts[0]).toContain(`${"t".repeat(6_000)} [truncated 1000 chars]`);
		expect(prompts[0]).not.toContain("t".repeat(6_001));
		const args = JSON.stringify({ body: "a".repeat(3_000) });
		expect(prompts[0]).toContain(
			`${args.slice(0, 2_000)} [truncated ${args.length - 2_000} chars]`,
		);
		expect(prompts[0]).toContain(`${"r".repeat(2_000)} [truncated 3000 chars]`);
		expect(prompts[0]).not.toContain("r".repeat(2_001));
	});
});

describe("failures", () => {
	it("logs the real error and does not retry for the rest of the turn", async () => {
		const prompts: string[] = [];
		const h = makeHarness({
			config: SMALL,
			model: fakeModel(new Error("upstream 429: rate limited"), prompts),
		});
		await memoryPlugin.setup(h.ctx);
		await h.fire(contextBuild, { system: "SYS", messages: bulkMessages(8, "x".repeat(60)) });

		await h.fire(stepEnd, turn("turn_1"));
		const warning = h.logs.find((log) => log.level === "warn")?.message ?? "";
		expect(warning).toContain("upstream 429: rate limited");
		expect(warning).not.toContain("capability unavailable");

		await h.fire(stepEnd, turn("turn_1"));
		await h.fire(turnEnd, turn("turn_1"));
		expect(prompts).toHaveLength(1); // one billed attempt for the whole turn

		await h.fire(stepEnd, turn("turn_2"));
		expect(prompts).toHaveLength(2); // the next turn tries again
	});

	it("clears the pause once a fold succeeds", async () => {
		let fail = true;
		const model = fakeModel("ROLLED UP");
		const chat = model.chat.bind(model);
		model.chat = (params) => {
			if (fail) throw new Error("boom");
			return chat(params);
		};
		const h = makeHarness({ config: SMALL, model });
		await memoryPlugin.setup(h.ctx);
		await h.fire(contextBuild, { system: "SYS", messages: bulkMessages(8, "x".repeat(60)) });
		await h.fire(stepEnd, turn("turn_1"));
		expect(await h.store.get("rolling_summary")).toMatchObject({ failedTurnId: "turn_1" });
		fail = false;
		await h.fire(stepEnd, turn("turn_2"));
		await expect(h.store.get("rolling_summary")).resolves.toEqual({
			summary: "ROLLED UP",
			summarizedUptoSeq: 6,
		});
	});

	it("never throttles /compact after an automatic failure", async () => {
		let fail = true;
		const prompts: string[] = [];
		const model = fakeModel("ROLLED UP", prompts);
		const chat = model.chat.bind(model);
		model.chat = (params) => {
			if (fail) throw new Error("boom");
			return chat(params);
		};
		const h = makeHarness({ config: SMALL, model });
		await memoryPlugin.setup(h.ctx);
		const path = withSeqs(bulkMessages(8, "x".repeat(60)));
		await h.fire(contextBuild, { system: "SYS", messages: path });
		await h.fire(stepEnd, turn("turn_1"));
		fail = false;

		const compact = h.commands.get("compact") as CommandHandler;
		const result = await compact("", {
			session: {},
			store: h.store,
			log: h.ctx.log,
			transcript: pathReader(path),
		} as unknown as CommandContext);
		expect(result).toEqual({
			reply: "Compacted 6 message(s) into the summary; the last 2 stay verbatim.",
		});
		expect(prompts).toHaveLength(1);
	});
});

describe("kept window", () => {
	it("is measured in tokens, and a cut between a tool call and its result moves past the result", async () => {
		const h = makeHarness({
			config: { max_context_tokens: 100, keep_recent_tokens: 33 },
			model: fakeModel("ROLLED UP"),
		});
		await memoryPlugin.setup(h.ctx);
		const messages: Message[] = [
			msg("user", "x".repeat(200)), // ~50 tokens
			toolCall("t1"),
			toolResult("t1", "out"),
			msg("user", "x".repeat(60)), // ~15 tokens
			msg("assistant", "x".repeat(60)), // ~15 tokens
		];
		await h.fire(contextBuild, { system: "SYS", messages });
		await h.fire(turnEnd);

		// Walking back, ~33 tokens are reached at the tool result: the cut moves past
		// it, so the call and its result fold together.
		const state = (await h.store.get("rolling_summary")) as { summarizedUptoSeq: number };
		expect(state.summarizedUptoSeq).toBe(3);
		const out = (await h.fire(contextBuild, { system: "SYS", messages })) as {
			mutations: { messages: Message[] };
		};
		expect(out.mutations.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
	});

	it("is never empty: a trailing tool call and its results stay together", async () => {
		const h = makeHarness({ config: SMALL, model: fakeModel("ROLLED UP") });
		await memoryPlugin.setup(h.ctx);
		const messages: Message[] = [
			msg("user", "x".repeat(400)),
			{
				role: "assistant",
				parts: [
					{ type: "tool_call", toolCall: { id: "a", name: "read", arguments: {} } },
					{ type: "tool_call", toolCall: { id: "b", name: "read", arguments: {} } },
				],
			},
			toolResult("a", "y".repeat(400)),
			toolResult("b", "y".repeat(400)),
		];
		await h.fire(contextBuild, { system: "SYS", messages });
		await h.fire(turnEnd);

		const state = (await h.store.get("rolling_summary")) as { summarizedUptoSeq: number };
		expect(state.summarizedUptoSeq).toBe(1); // only the user message folds
		const out = (await h.fire(contextBuild, { system: "SYS", messages })) as {
			mutations: { messages: Message[] };
		};
		expect(out.mutations.messages.map((m) => m.role)).toEqual(["assistant", "tool", "tool"]);
	});

	it("is at most half the threshold, so a fold makes room", async () => {
		const prompts: string[] = [];
		// keep_recent_tokens 20000 would keep everything; half of the 80-token threshold is 40.
		const h = makeHarness({
			config: { max_context_tokens: 100, keep_recent_tokens: 20_000 },
			model: fakeModel("ROLLED UP", prompts),
		});
		await memoryPlugin.setup(h.ctx);
		await h.fire(contextBuild, { system: "SYS", messages: bulkMessages(8, "x".repeat(60)) });
		await h.fire(turnEnd);
		const state = (await h.store.get("rolling_summary")) as { summarizedUptoSeq: number };
		expect(state.summarizedUptoSeq).toBe(5); // 3 × 18 ≥ 40 → the last 3 stay
	});
});

describe("/compact slash command", () => {
	function history(count: number): Message[] {
		return Array.from({ length: count }, (_, index) => ({
			seq: index + 1,
			role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
			parts: [{ type: "text" as const, text: `message ${index + 1}`, visibility: "chat" as const }],
		}));
	}
	function commandCtx(store: SessionStore, ctx: PluginContext, messages: Message[]) {
		return {
			session: {},
			store,
			log: ctx.log,
			transcript: pathReader(messages),
		} as unknown as CommandContext;
	}

	it("registers /compact under the manifest-declared name", async () => {
		const { ctx, commands } = makeHarness({});
		await memoryPlugin.setup(ctx);
		expect(memoryPlugin.provides).toEqual({ commands: ["compact"] });
		expect([...commands.keys()]).toEqual(["compact"]);
	});

	it("folds on demand below the threshold, keeps the recent window, and steers with the focus text", async () => {
		const prompts: string[] = [];
		// Each "message N" is ~3 tokens: a 12-token window keeps the last 4.
		const { ctx, commands, store } = makeHarness({
			config: { keep_recent_tokens: 12, max_context_tokens: 1_000_000 },
			model: fakeModel("SUMMARY", prompts),
		});
		await memoryPlugin.setup(ctx);
		const compact = commands.get("compact") as CommandHandler;
		const cctx = commandCtx(store, ctx, history(10));

		const result = await compact("billing decisions", cctx);

		expect(result).toEqual({
			reply: "Compacted 6 message(s) into the summary; the last 4 stay verbatim.",
		});
		expect(prompts).toHaveLength(1);
		expect(prompts[0]).toContain("message 6");
		expect(prompts[0]).not.toContain("message 7");
		expect(prompts[0]).toContain("preserving anything related to: billing decisions");
		await expect(store.get("rolling_summary")).resolves.toEqual({
			summary: "SUMMARY",
			summarizedUptoSeq: 6,
		});

		// Nothing new has aged out: the second run is a no-op with an honest reply.
		await expect(compact("", cctx)).resolves.toEqual({
			reply:
				"Nothing to compact: the conversation since the last summary fits in the recent window (~12 tokens).",
		});
		expect(prompts).toHaveLength(1);
	});

	it("reports a summary model that returns no text as a failure, not as too few messages", async () => {
		const { ctx, commands, store } = makeHarness({
			config: { keep_recent_tokens: 12, max_context_tokens: 1_000_000 },
			model: fakeModel(""),
		});
		await memoryPlugin.setup(ctx);
		const compact = commands.get("compact") as CommandHandler;
		await expect(compact("", commandCtx(store, ctx, history(10)))).rejects.toThrow(
			/returned no text/,
		);
		expect(await store.get("rolling_summary")).toBeNull();
	});

	it("fails honestly without a transcript reader", async () => {
		const { ctx, commands, store } = makeHarness({});
		await memoryPlugin.setup(ctx);
		const compact = commands.get("compact") as CommandHandler;
		await expect(
			compact("", { session: {}, store, log: ctx.log } as unknown as CommandContext),
		).rejects.toThrow(/transcript reader/);
	});
});
