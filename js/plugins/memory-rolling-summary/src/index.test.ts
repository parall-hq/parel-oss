import type {
	HookHandler,
	LifecycleEvent,
	Message,
	ModelGatewayAccess,
	PluginContext,
	SessionStore,
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
		provide() {},
		require() {
			throw new Error("not provided");
		},
		interrupt() {},
	} as unknown as PluginContext;
	return { ctx, hooks, store };
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
			summarizedCount: number;
		} | null;
		expect(state).not.toBeNull();
		expect(state?.summary).toBe("ROLLED UP");
		// 8 messages, keep last 2 → first 6 folded.
		expect(state?.summarizedCount).toBe(6);
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
		// Seed a known prior summary, then grow the window and compact again.
		await h.store.set("rolling_summary", { summary: "PRIOR SUMMARY", summarizedCount: 6 });
		await h.hooks.get(contextBuild)?.({
			system: "SYS",
			messages: bulkMessages(16, "x".repeat(60)),
		} as never);
		await h.hooks.get(turnEnd)?.({} as never);

		const last = prompts.at(-1) ?? "";
		expect(last).toContain("PRIOR SUMMARY"); // folded the existing summary
		const state = (await h.store.get("rolling_summary")) as { summarizedCount: number };
		expect(state.summarizedCount).toBe(14); // 16 - keepRecent(2)
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
		const state = (await h.store.get("rolling_summary")) as { summarizedCount: number };
		expect(state.summarizedCount).toBe(3);

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
});
