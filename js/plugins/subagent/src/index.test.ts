import {
	type HookHandler,
	type InputQueueItem,
	LifecycleEvent,
	type ModelGatewayAccess,
	PAREL_RUNTIME_CAPABILITY,
	type PluginContext,
	type RuntimeControl,
	type ToolDefinition,
	type ToolHandler,
	type ToolHandlerContext,
} from "@parel/plugin-sdk";
import { describe, expect, it, vi } from "vitest";
import subagentPlugin from "./index.js";

function fakeModel(text: string): ModelGatewayAccess {
	return {
		async *chat() {
			yield { type: "text_delta" as const, text };
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

function fakeInputs(items: InputQueueItem[] = []) {
	let store = [...items];
	return {
		drain(type: string) {
			const matched = store.filter((i) => i.type === type);
			store = store.filter((i) => i.type !== type);
			return matched;
		},
		drainWhere(type: string, predicate: (item: InputQueueItem) => boolean) {
			const matched: InputQueueItem[] = [];
			const remaining: InputQueueItem[] = [];
			for (const item of store) {
				if (item.type === type && predicate(item)) {
					matched.push(item);
				} else {
					remaining.push(item);
				}
			}
			store = remaining;
			return matched;
		},
		peek(type: string) {
			return store.filter((i) => i.type === type);
		},
		push(item: Omit<InputQueueItem, "id" | "timestamp">) {
			store.push({ ...item, id: `p${store.length}`, timestamp: 0 });
		},
	};
}

interface Harness {
	ctx: PluginContext;
	tools: Map<string, { def: ToolDefinition; handler: ToolHandler }>;
	hooks: Map<string, HookHandler<LifecycleEvent>>;
}

function makeHarness(opts: {
	config?: Record<string, unknown>;
	model?: ModelGatewayAccess;
	runtime?: RuntimeControl;
	inputs?: ReturnType<typeof fakeInputs>;
}): Harness {
	const hooks = new Map<string, HookHandler<LifecycleEvent>>();
	const tools = new Map<string, { def: ToolDefinition; handler: ToolHandler }>();

	const ctx = {
		config: opts.config ?? {},
		model: opts.model ?? fakeModel("ok"),
		inputs: opts.inputs ?? fakeInputs(),
		store: {} as PluginContext["store"],
		log: { debug() {}, info() {}, warn() {}, error() {} },
		require<T>(name: string): T {
			if (name === PAREL_RUNTIME_CAPABILITY && opts.runtime) return opts.runtime as T;
			throw new Error(`capability not provided: ${name}`);
		},
		tool(def: ToolDefinition, handler: ToolHandler) {
			tools.set(def.name, { def, handler });
		},
		hook(event: string, handler: HookHandler<LifecycleEvent>) {
			hooks.set(event, handler);
		},
		provide() {},
		interrupt() {},
	} as unknown as PluginContext;

	return { ctx, tools, hooks };
}

function toolOf(h: Harness, name: string): ToolHandler {
	const t = h.tools.get(name);
	if (!t) throw new Error(`tool not registered: ${name}`);
	return t.handler;
}

const toolCtx = {
	session: { id: "sess-1" },
	invocation: {
		sessionId: "sess-1",
		turnId: "turn-1",
		stepNumber: 3,
		toolCallId: "tc-1",
		toolName: "subagent",
		pluginName: "@parel/subagent",
	},
	log: {},
	store: {},
} as unknown as ToolHandlerContext;

describe("@parel/subagent", () => {
	it("sync inline: returns the model's text", async () => {
		const h = makeHarness({ model: fakeModel("delegated answer") });
		await subagentPlugin.setup(h.ctx);
		const result = await toolOf(h, "subagent")({ task: "do a thing" }, toolCtx);
		expect(result).toBe("delegated answer");
	});

	it("rejects empty task", async () => {
		const h = makeHarness({});
		await subagentPlugin.setup(h.ctx);
		const result = await toolOf(h, "subagent")({ task: "   " }, toolCtx);
		expect(result).toContain("required");
	});

	it("async: spawns via runtime and returns an ack", async () => {
		const startChildSession = vi.fn().mockResolvedValue({
			childInvocationId: "inv-1",
			childSessionId: "child-1",
		});
		const runtime = { startChildSession } as unknown as RuntimeControl;
		const h = makeHarness({ runtime, config: { agent: "researcher" } });
		await subagentPlugin.setup(h.ctx);

		const result = await toolOf(h, "subagent")({ task: "research X", mode: "async" }, toolCtx);
		expect(startChildSession).toHaveBeenCalledOnce();
		const arg = startChildSession.mock.calls[0][0];
		expect(arg.agent).toBe("researcher");
		expect(arg.input).toBe("research X");
		expect(arg.mode).toBe("async");
		expect(typeof arg.idempotencyKey).toBe("string");
		expect(arg.origin).toEqual({
			parentTurnId: "turn-1",
			parentStepId: "3",
			parentToolCallId: "tc-1",
			originPlugin: "@parel/subagent",
		});
		expect(result).toContain("child-1");
	});

	it("async fork: can spawn without an explicit child agent", async () => {
		const startChildSession = vi.fn().mockResolvedValue({
			childInvocationId: "inv-1",
			childSessionId: "child-1",
		});
		const runtime = { startChildSession } as unknown as RuntimeControl;
		const h = makeHarness({ runtime });
		await subagentPlugin.setup(h.ctx);

		const result = await toolOf(h, "subagent")(
			{ task: "verify current change", mode: "async", context: "fork" },
			toolCtx,
		);

		expect(startChildSession).toHaveBeenCalledOnce();
		const arg = startChildSession.mock.calls[0][0];
		expect(arg.agent).toBeUndefined();
		expect(arg.context).toBe("fork");
		expect(result).toContain("child-1");
	});

	it("async without runtime falls back to sync inline", async () => {
		const h = makeHarness({ model: fakeModel("fell back") });
		await subagentPlugin.setup(h.ctx);
		const result = await toolOf(h, "subagent")({ task: "x", mode: "async", agent: "r" }, toolCtx);
		expect(result).toBe("fell back");
	});

	it("renders subagent async_callback inputs as <subagent_notification>", async () => {
		const inputs = fakeInputs([
			{
				id: "i1",
				type: "async_callback",
				source: "runtime",
				timestamp: 0,
				payload: {
					callbackKind: "subagent_result",
					childSessionId: "child-1",
					status: "completed",
					summary: "found 3 things",
				},
			},
			{
				id: "i2",
				type: "async_callback",
				source: "runtime",
				timestamp: 1,
				payload: { callbackKind: "approval_result", summary: "ignored" },
			},
		]);
		const h = makeHarness({ inputs });
		await subagentPlugin.setup(h.ctx);
		const hook = h.hooks.get(LifecycleEvent.ContextBuild);
		expect(hook).toBeDefined();
		const out = await hook?.({ messages: [], inputs } as never);
		const messages = (out as { mutations: { messages: { parts: { text: string }[] }[] } }).mutations
			.messages;
		expect(messages).toHaveLength(1);
		expect(messages[0].parts[0].text).toContain("<subagent_notification");
		expect(messages[0].parts[0].text).toContain("found 3 things");
		expect(inputs.peek("async_callback")).toHaveLength(1);
		expect(inputs.peek("async_callback")[0].payload).toEqual({
			callbackKind: "approval_result",
			summary: "ignored",
		});
	});

	it("keeps legacy subagent_result inputs compatible", async () => {
		const inputs = fakeInputs([
			{
				id: "i1",
				type: "subagent_result",
				source: "runtime",
				timestamp: 0,
				payload: { childSessionId: "child-1", status: "completed", summary: "legacy result" },
			},
		]);
		const h = makeHarness({ inputs });
		await subagentPlugin.setup(h.ctx);
		const hook = h.hooks.get(LifecycleEvent.ContextBuild);
		const out = await hook?.({ messages: [], inputs } as never);
		const messages = (out as { mutations: { messages: { parts: { text: string }[] }[] } }).mutations
			.messages;
		expect(messages[0].parts[0].text).toContain("legacy result");
	});

	it("preserves async_callback inputs for other callback kinds", async () => {
		const inputs = fakeInputs([
			{
				id: "i1",
				type: "async_callback",
				source: "@parel/subagent",
				timestamp: 0,
				payload: {
					callbackKind: "subagent_result",
					childSessionId: "child-1",
					status: "completed",
					summary: "subagent result",
				},
			},
			{
				id: "i2",
				type: "async_callback",
				source: "@parel/approval",
				timestamp: 0,
				payload: { callbackKind: "approval_result", status: "approved" },
			},
		]);
		const h = makeHarness({ inputs });
		await subagentPlugin.setup(h.ctx);
		const hook = h.hooks.get(LifecycleEvent.ContextBuild);
		await hook?.({ messages: [], inputs } as never);
		expect(inputs.peek("async_callback")).toEqual([
			expect.objectContaining({
				source: "@parel/approval",
				payload: { callbackKind: "approval_result", status: "approved" },
			}),
		]);
	});

	it("subagent_status: reports child state via runtime.getChild", async () => {
		const getChild = vi.fn().mockResolvedValue({ status: "running", childSessionId: "child-9" });
		const runtime = { getChild } as unknown as RuntimeControl;
		const h = makeHarness({ runtime });
		await subagentPlugin.setup(h.ctx);

		const result = await toolOf(h, "subagent_status")({ invocation_id: "inv-9" }, toolCtx);
		expect(getChild).toHaveBeenCalledWith("inv-9");
		expect(result).toContain("status=running");
		expect(result).toContain("session=child-9");
	});

	it("subagent_cancel / subagent_signal: call runtime and ack", async () => {
		const cancelChild = vi.fn().mockResolvedValue(undefined);
		const signalChild = vi.fn().mockResolvedValue(undefined);
		const runtime = { cancelChild, signalChild } as unknown as RuntimeControl;
		const h = makeHarness({ runtime });
		await subagentPlugin.setup(h.ctx);

		expect(await toolOf(h, "subagent_cancel")({ invocation_id: "inv-1" }, toolCtx)).toContain(
			"Cancelled",
		);
		expect(cancelChild).toHaveBeenCalledWith("inv-1");

		const signal = await toolOf(h, "subagent_signal")(
			{ invocation_id: "inv-1", message: "focus on X" },
			toolCtx,
		);
		expect(signal).toContain("Signalled");
		expect(signalChild).toHaveBeenCalledWith("inv-1", "focus on X");
	});

	it("control tools report clearly when no runtime is provided", async () => {
		const h = makeHarness({}); // no runtime
		await subagentPlugin.setup(h.ctx);
		const result = await toolOf(h, "subagent_status")({ invocation_id: "inv-1" }, toolCtx);
		expect(result).toContain("parel.runtime");
	});

	it("subagent_signal requires a message", async () => {
		const runtime = { signalChild: vi.fn() } as unknown as RuntimeControl;
		const h = makeHarness({ runtime });
		await subagentPlugin.setup(h.ctx);
		const result = await toolOf(h, "subagent_signal")({ invocation_id: "inv-1" }, toolCtx);
		expect(result).toContain("required");
	});
});
