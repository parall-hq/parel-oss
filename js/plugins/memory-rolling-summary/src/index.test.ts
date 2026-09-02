import type {
	CommandContext,
	CommandHandler,
	HookHandler,
	LifecycleEvent,
	Message,
	ModelGatewayAccess,
	PluginContext,
	SessionStore,
	TranscriptReader,
} from "@parel/plugin-sdk";
import { describe, expect, it } from "vitest";
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

function fakeModel(reply: string, prompts: string[] = []): ModelGatewayAccess {
	return {
		async *chat(params) {
			prompts.push((params.messages[0].parts[0] as { text: string }).text);
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
	const hooks = new Map<string, HookHandler<LifecycleEvent>>();
	const commands = new Map<string, CommandHandler>();
	const store = opts.store ?? makeStore();
	const ctx = {
		config: opts.config ?? {},
		model: opts.model ?? fakeModel("SUMMARY"),
		store,
		inputs: { drain: () => [], peek: () => [], push() {} },
		log: { debug() {}, info() {}, warn() {}, error() {} },
		hook(event: string, handler: HookHandler<LifecycleEvent>) {
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
	return { ctx, hooks, commands, store };
}

function msg(role: Message["role"], text: string): Message {
	return { role, parts: [{ type: "text", text }] };
}

// Build messages whose combined text comfortably exceeds a small threshold.
function bulkMessages(n: number, filler: string): Message[] {
	return Array.from({ length: n }, (_, i) =>
		msg(i % 2 === 0 ? "user" : "assistant", `${filler} message ${i}`),
	);
}

const contextBuild = "context:build";
const turnEnd = "turn:end";

describe("@parel/memory-rolling-summary", () => {
	it("does nothing while under the threshold", async () => {
		const prompts: string[] = [];
		const h = makeHarness({
			config: { max_context_tokens: 100_000 },
			model: fakeModel("SUMMARY", prompts),
		});
		await memoryPlugin.setup(h.ctx);

		const cb = h.hooks.get(contextBuild);
		const built = await cb?.({ system: "SYS", messages: [msg("user", "hi")] } as never);
		expect(built).toBeUndefined(); // no summary yet → no mutation

		await h.hooks.get(turnEnd)?.({} as never);
		expect(prompts).toHaveLength(0); // never called the model
		expect(await h.store.get("rolling_summary")).toBeNull();
	});

	it("compacts older messages into a summary once the window is large", async () => {
		const prompts: string[] = [];
		// threshold = 100 * 0.8 = 80 tokens (~320 chars); keep the last 2 messages.
		const h = makeHarness({
			config: { max_context_tokens: 100, compact_at: 0.8, keep_recent_messages: 2 },
			model: fakeModel("ROLLED UP", prompts),
		});
		await memoryPlugin.setup(h.ctx);

		const messages = bulkMessages(8, "x".repeat(60));
		await h.hooks.get(contextBuild)?.({ system: "SYS", messages } as never);
		await h.hooks.get(turnEnd)?.({} as never);

		const state = (await h.store.get("rolling_summary")) as {
			summary: string;
			summarizedUptoSeq: number;
		} | null;
		expect(state).not.toBeNull();
		expect(state?.summary).toBe("ROLLED UP");
		// 8 messages, keep last 2 → first 6 folded (path coordinate 6).
		expect(state?.summarizedUptoSeq).toBe(6);
		expect(prompts).toHaveLength(1);
		expect(prompts[0]).toContain("message 0"); // oldest folded
		expect(prompts[0]).not.toContain("message 7"); // recent kept verbatim
	});

	it("prunes the summarized prefix and injects the summary on the next build", async () => {
		const h = makeHarness({
			config: { max_context_tokens: 100, keep_recent_messages: 2 },
			model: fakeModel("ROLLED UP"),
		});
		await memoryPlugin.setup(h.ctx);

		const messages = bulkMessages(8, "x".repeat(60));
		await h.hooks.get(contextBuild)?.({ system: "SYS", messages } as never);
		await h.hooks.get(turnEnd)?.({} as never);

		const out = (await h.hooks.get(contextBuild)?.({ system: "SYS", messages } as never)) as {
			mutations: { system: string; messages: Message[] };
		};
		expect(out.mutations.messages).toHaveLength(2); // only the recent kept
		expect(out.mutations.system).toContain("<conversation-summary>");
		expect(out.mutations.system).toContain("ROLLED UP");
	});

	it("rolls forward: the prior summary is folded into the next one", async () => {
		const prompts: string[] = [];
		const h = makeHarness({
			config: { max_context_tokens: 100, keep_recent_messages: 2 },
			model: fakeModel("SUMMARY v2", prompts),
		});
		await memoryPlugin.setup(h.ctx);

		// First compaction.
		await h.hooks.get(contextBuild)?.({
			system: "SYS",
			messages: bulkMessages(8, "x".repeat(60)),
		} as never);
		await h.hooks.get(turnEnd)?.({} as never);
		// Seed a known prior summary in the LEGACY count-based shape, then grow the
		// window and compact again — the count reads as a path coordinate.
		await h.store.set("rolling_summary", { summary: "PRIOR SUMMARY", summarizedCount: 6 });
		await h.hooks.get(contextBuild)?.({
			system: "SYS",
			messages: bulkMessages(16, "x".repeat(60)),
		} as never);
		await h.hooks.get(turnEnd)?.({} as never);

		const last = prompts.at(-1) ?? "";
		expect(last).toContain("PRIOR SUMMARY"); // folded the existing summary
		const state = (await h.store.get("rolling_summary")) as { summarizedUptoSeq: number };
		expect(state.summarizedUptoSeq).toBe(14); // 16 - keepRecent(2)
	});

	it("keeps prior state when the model returns nothing", async () => {
		const h = makeHarness({
			config: { max_context_tokens: 100, keep_recent_messages: 2 },
			model: fakeModel("   "), // whitespace only → trimmed empty
		});
		await memoryPlugin.setup(h.ctx);
		await h.hooks.get(contextBuild)?.({
			system: "SYS",
			messages: bulkMessages(8, "x".repeat(60)),
		} as never);
		await h.hooks.get(turnEnd)?.({} as never);
		expect(await h.store.get("rolling_summary")).toBeNull(); // not advanced
	});

	it("does not leak hidden reasoning into the summary", async () => {
		const prompts: string[] = [];
		const h = makeHarness({
			config: { max_context_tokens: 100, keep_recent_messages: 2 },
			model: fakeModel("ROLLED UP", prompts),
		});
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
		await h.hooks.get(contextBuild)?.({ system: "SYS", messages } as never);
		await h.hooks.get(turnEnd)?.({} as never);

		expect(prompts).toHaveLength(1);
		expect(prompts[0]).not.toContain("SECRET_CHAIN_OF_THOUGHT");
	});

	it("snaps the prune boundary past orphan tool results", async () => {
		const h = makeHarness({
			config: { max_context_tokens: 100, keep_recent_messages: 4 },
			model: fakeModel("ROLLED UP"),
		});
		await memoryPlugin.setup(h.ctx);

		const big = "x".repeat(120);
		const messages: Message[] = [
			msg("user", big),
			{
				role: "assistant",
				parts: [{ type: "tool_call", toolCall: { id: "t1", name: "bash", arguments: {} } }],
			},
			{ role: "tool", parts: [{ type: "tool_result", toolCallId: "t1", content: "out" }] },
			msg("user", big),
			msg("assistant", big),
			msg("assistant", big),
		];
		await h.hooks.get(contextBuild)?.({ system: "SYS", messages } as never);
		await h.hooks.get(turnEnd)?.({} as never);

		// desired boundary (len 6 - keepRecent 4 = 2) lands on the tool result, so it
		// snaps forward to 3 — the tool call/result pair is folded together.
		const state = (await h.store.get("rolling_summary")) as { summarizedUptoSeq: number };
		expect(state.summarizedUptoSeq).toBe(3);

		const out = (await h.hooks.get(contextBuild)?.({ system: "SYS", messages } as never)) as {
			mutations: { messages: Message[] };
		};
		expect(out.mutations.messages[0].role).not.toBe("tool"); // no orphan result
	});

	it("represents attachments with a placeholder instead of dropping them silently", async () => {
		const prompts: string[] = [];
		const h = makeHarness({
			config: { max_context_tokens: 100, keep_recent_messages: 2 },
			model: fakeModel("ROLLED UP", prompts),
		});
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
		await h.hooks.get(contextBuild)?.({ system: "SYS", messages } as never);
		await h.hooks.get(turnEnd)?.({} as never);

		expect(prompts[0]).toContain("[file report.pdf]"); // attachment noted
		expect(prompts[0]).not.toContain("BASE64DATA"); // raw payload not leaked
	});
	it("on a lazy host (no pushed messages) it reads only the tail through hookCtx.transcript", async () => {
		const prompts: string[] = [];
		const h = makeHarness({
			config: { max_context_tokens: 100, keep_recent_messages: 2 },
			model: fakeModel("ROLLED UP", prompts),
		});
		await memoryPlugin.setup(h.ctx);
		// A pointer-forked path: seqs continue from a parent (101..108).
		const path = bulkMessages(8, "x".repeat(60)).map((m, i) => ({ ...m, seq: 101 + i }));
		const reads: { fromSeq?: number }[] = [];
		const transcript = {
			generation: 0,
			async read(range?: { fromSeq?: number }) {
				reads.push(range ?? {});
				return path.filter((m) => m.seq >= (range?.fromSeq ?? 1));
			},
		};
		// First build: nothing summarized → the whole path is supplied as the window.
		const first = (await h.hooks.get(contextBuild)?.({ system: "SYS", transcript } as never)) as {
			mutations: { messages: Message[] };
		};
		expect(first.mutations.messages).toHaveLength(8);
		expect(reads.at(-1)).toEqual({ fromSeq: 1 });
		await h.hooks.get(turnEnd)?.({} as never);
		const state = (await h.store.get("rolling_summary")) as { summarizedUptoSeq: number };
		expect(state.summarizedUptoSeq).toBe(106); // 101..106 folded, 107/108 kept
		expect(prompts[0]).toContain("message 0");
		expect(prompts[0]).not.toContain("message 7");
		// Second build: only the tail past the mark is read and returned.
		const second = (await h.hooks.get(contextBuild)?.({ system: "SYS", transcript } as never)) as {
			mutations: { system: string; messages: Message[] };
		};
		expect(reads.at(-1)).toEqual({ fromSeq: 107 });
		expect(second.mutations.messages.map((m) => m.seq)).toEqual([107, 108]);
		expect(second.mutations.system).toContain("ROLLED UP");
	});

	it("also rolls forward at step:end so a long turn cannot blow the window", async () => {
		const prompts: string[] = [];
		const h = makeHarness({
			config: { max_context_tokens: 100, keep_recent_messages: 2 },
			model: fakeModel("MID-TURN", prompts),
		});
		await memoryPlugin.setup(h.ctx);
		await h.hooks.get(contextBuild)?.({
			system: "SYS",
			messages: bulkMessages(8, "x".repeat(60)),
		} as never);
		await h.hooks.get("step:end")?.({} as never);
		expect(prompts).toHaveLength(1);
		const state = (await h.store.get("rolling_summary")) as { summarizedUptoSeq: number };
		expect(state.summarizedUptoSeq).toBe(6);
	});

	it("takes the budget from the adapter's advertised window when not configured", async () => {
		const prompts: string[] = [];
		// fakeModel advertises maxContextTokens 1000 → threshold 800 tokens (~3200 chars):
		// 8 × 60 chars stays under it, so nothing compacts without a config override.
		const h = makeHarness({ config: {}, model: fakeModel("ROLLED UP", prompts) });
		await memoryPlugin.setup(h.ctx);
		await h.hooks.get(contextBuild)?.({
			system: "SYS",
			messages: bulkMessages(8, "x".repeat(60)),
		} as never);
		await h.hooks.get(turnEnd)?.({} as never);
		expect(prompts).toHaveLength(0);
	});
});

describe("/compact slash command", () => {
	function reader(messages: Message[]): TranscriptReader {
		return {
			generation: 1,
			async read(range) {
				return messages.filter((message) => (message.seq ?? 0) >= (range?.fromSeq ?? 1));
			},
		};
	}
	function history(count: number): Message[] {
		return Array.from({ length: count }, (_, index) => ({
			seq: index + 1,
			role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
			parts: [{ type: "text" as const, text: `message ${index + 1}`, visibility: "chat" as const }],
		}));
	}

	it("registers /compact under the manifest-declared name", async () => {
		const { ctx, commands } = makeHarness({});
		await memoryPlugin.setup(ctx);
		expect(memoryPlugin.provides).toEqual({ commands: ["compact"] });
		expect([...commands.keys()]).toEqual(["compact"]);
	});

	it("folds on demand below the threshold, keeps the recent window, and steers with the focus text", async () => {
		const prompts: string[] = [];
		const { ctx, commands, store } = makeHarness({
			config: { keep_recent_messages: 4, max_context_tokens: 1_000_000 },
			model: fakeModel("SUMMARY", prompts),
		});
		await memoryPlugin.setup(ctx);
		const compact = commands.get("compact") as CommandHandler;
		const commandCtx = {
			session: {},
			store,
			log: ctx.log,
			transcript: reader(history(10)),
		} as unknown as CommandContext;

		const result = await compact("billing decisions", commandCtx);

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
		await expect(compact("", commandCtx)).resolves.toEqual({
			reply: "Nothing to compact: fewer than 4 messages beyond the summary.",
		});
		expect(prompts).toHaveLength(1);
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
