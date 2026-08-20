import {
	type InputQueueItem,
	type NormalizeHandler,
	type PluginContext,
	type SessionStore,
	type ToolDefinition,
	type ToolHandler,
} from "@parel/plugin-sdk";
import { describe, expect, it, vi } from "vitest";
import type { ApprovalRequestRecord } from "./index.js";
import approvalToolsPlugin from "./index.js";

interface Harness {
	ctx: PluginContext;
	tools: Map<string, { def: ToolDefinition; handler: ToolHandler }>;
	normalizers: { types: string[]; handler: NormalizeHandler }[];
	store: SessionStore;
	interrupt: ReturnType<typeof vi.fn>;
	inputItems: InputQueueItem[];
}

function makeStore(): SessionStore & { records: Map<string, unknown> } {
	const records = new Map<string, unknown>();
	return {
		records,
		async get<T = unknown>(key: string): Promise<T | null> {
			return (records.get(key) as T | undefined) ?? null;
		},
		async set<T = unknown>(key: string, value: T): Promise<void> {
			records.set(key, value);
		},
		async delete(key: string): Promise<void> {
			records.delete(key);
		},
		async list(prefix = ""): Promise<string[]> {
			return [...records.keys()].filter((key) => key.startsWith(prefix));
		},
	};
}

function makeHarness(inputItems: InputQueueItem[] = []): Harness {
	const tools = new Map<string, { def: ToolDefinition; handler: ToolHandler }>();
	const normalizers: { types: string[]; handler: NormalizeHandler }[] = [];
	const store = makeStore();
	const interrupt = vi.fn();
	const ctx = {
		config: {},
		store,
		inputs: {
			drain(type: string) {
				const matched = inputItems.filter((item) => item.type === type);
				for (const item of matched) inputItems.splice(inputItems.indexOf(item), 1);
				return matched;
			},
			drainWhere(type: string, predicate: (item: InputQueueItem) => boolean) {
				const matched: InputQueueItem[] = [];
				const remaining: InputQueueItem[] = [];
				for (const item of inputItems) {
					if (item.type === type && predicate(item)) matched.push(item);
					else remaining.push(item);
				}
				inputItems.splice(0, inputItems.length, ...remaining);
				return matched;
			},
			peek(type: string) {
				return inputItems.filter((item) => item.type === type);
			},
			push(item: Omit<InputQueueItem, "id" | "timestamp">) {
				inputItems.push({ ...item, id: `input_${inputItems.length + 1}`, timestamp: Date.now() });
			},
		},
		model: {} as PluginContext["model"],
		log: { debug() {}, info() {}, warn() {}, error() {} },
		require<T>(name: string): T {
			throw new Error(`capability not provided: ${name}`);
		},
		tool(def: ToolDefinition, handler: ToolHandler) {
			tools.set(def.name, { def, handler });
		},
		hook() {},
		normalize(types: string[], handler: NormalizeHandler) {
			normalizers.push({ types, handler });
		},
		provide() {},
		interrupt,
	} as unknown as PluginContext;
	return { ctx, tools, normalizers, store, interrupt, inputItems };
}

describe("@parel/approval-tools", () => {
	it("stores a pending approval request and interrupts the turn", async () => {
		const h = makeHarness();
		await approvalToolsPlugin.setup(h.ctx);

		const result = await h.tools.get("request_approval")?.handler(
			{
				action: "run deploy",
				reason: "deploy changes",
				risk: "high",
				details: "pnpm deploy",
			},
			{
				store: h.store,
				invocation: { sessionId: "s1", toolCallId: "call_1", toolName: "request_approval" },
			} as never,
		);

		expect(result).toMatchObject({
			content: expect.stringContaining("approval_call_1"),
		});
		expect(h.interrupt).toHaveBeenCalledTimes(1);
		await expect(
			h.store.get<ApprovalRequestRecord>("approval:approval_call_1"),
		).resolves.toMatchObject({
			approvalId: "approval_call_1",
			status: "pending",
			action: "run deploy",
			risk: "high",
			details: "pnpm deploy",
			requestedByToolCallId: "call_1",
		});
	});

	it("normalizes approval_result callbacks into transcript messages and updates stored status", async () => {
		const h = makeHarness();
		await h.store.set<ApprovalRequestRecord>("approval:approval_call_1", {
			approvalId: "approval_call_1",
			status: "pending",
			action: "run deploy",
			risk: "high",
			requestedAt: "earlier",
		});
		await approvalToolsPlugin.setup(h.ctx);

		expect(h.normalizers).toHaveLength(1);
		expect(h.normalizers[0]?.types).toEqual(["async_callback"]);
		const normalize = h.normalizers[0]?.handler as NormalizeHandler;
		const normalizeCtx = {
			session: {} as never,
			store: h.store,
			inputs: h.ctx.inputs,
			log: { debug() {}, info() {}, warn() {}, error() {} },
		};

		const messages = await normalize(
			"async_callback",
			{
				callbackKind: "approval_result",
				approvalId: "approval_call_1",
				status: "approved",
				comment: "Proceed",
				resolvedBy: "user-1",
			},
			normalizeCtx,
		);
		expect(messages).toEqual([
			{
				role: "user",
				parts: [
					{
						type: "text",
						text: expect.stringContaining(
							'<approval_result id="approval_call_1" status="approved">',
						),
						visibility: "chat",
					},
				],
			},
		]);
		await expect(
			h.store.get<ApprovalRequestRecord>("approval:approval_call_1"),
		).resolves.toMatchObject({
			status: "approved",
			resolvedBy: "user-1",
			comment: "Proceed",
			action: "run deploy",
			requestedAt: "earlier",
		});

		// Non-approval callbacks are deferred untouched to other normalizers or the
		// host fallback — never claimed, never store-mutated.
		await expect(
			normalize(
				"async_callback",
				{ callbackKind: "subagent_result", summary: "leave me alone" },
				normalizeCtx,
			),
		).resolves.toBeNull();
	});

	it("checks stored approval status", async () => {
		const h = makeHarness();
		await h.store.set<ApprovalRequestRecord>("approval:approval_call_1", {
			approvalId: "approval_call_1",
			status: "rejected",
			action: "delete files",
			risk: "destructive",
			requestedAt: "earlier",
			comment: "Do not delete this",
		});
		await approvalToolsPlugin.setup(h.ctx);

		const result = await h.tools
			.get("check_approval")
			?.handler({ approvalId: "approval_call_1" }, { store: h.store } as never);

		expect(result).toContain("status: rejected");
		expect(result).toContain("comment: Do not delete this");
		expect(h.tools.get("check_approval")?.def.scheduling?.defaultMode).toBe("parallel");
	});
});
