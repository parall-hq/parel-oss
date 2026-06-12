import type { LifecycleEventType, PluginContext, SessionState } from "@parel/plugin-sdk";
import { LifecycleEvent } from "@parel/plugin-sdk";
import { describe, expect, test } from "vitest";
import plugin from "./index.js";

type CapturedHook = {
	event: LifecycleEventType;
	handler: (
		ctx: Record<string, unknown>,
	) => Promise<{ action: string; reason?: string } | undefined>;
};

function createPluginContext(config: Record<string, unknown>) {
	let captured: CapturedHook | undefined;
	const ctx = {
		config,
		hook: (event: LifecycleEventType, handler: CapturedHook["handler"]) => {
			captured = { event, handler };
		},
	} as unknown as PluginContext;

	return {
		ctx,
		getHook() {
			if (!captured) throw new Error("No hook registered");
			return captured;
		},
	};
}

function createHookContext(overrides: Partial<SessionState> = {}) {
	return {
		event: LifecycleEvent.ModelBefore,
		session: {
			id: "s1",
			agentId: "a1",
			orgId: "org1",
			status: "running",
			turnCount: 1,
			stepCount: 0,
			totalTokens: 0,
			totalCostUsd: 0,
			createdAt: Date.now(),
			updatedAt: Date.now(),
			...overrides,
		},
		modelParams: { messages: [] },
		store: {},
		inputs: {},
		tools: {},
	};
}

describe("budget-cap", () => {
	test("blocks before model calls when cost budget is exhausted", async () => {
		const { ctx, getHook } = createPluginContext({ max_usd: 1 });

		await plugin.setup(ctx);
		const hook = getHook();
		const result = await hook.handler(createHookContext({ totalCostUsd: 1 }));

		expect(hook.event).toBe(LifecycleEvent.ModelBefore);
		expect(result).toEqual({
			action: "stop",
			reason: "Budget exceeded: $1.00 >= $1",
		});
	});

	test("supports legacy daily budget config", async () => {
		const { ctx, getHook } = createPluginContext({ daily: 0.5 });

		await plugin.setup(ctx);
		const result = await getHook().handler(createHookContext({ totalCostUsd: 0.5 }));

		expect(result?.action).toBe("stop");
		expect(result?.reason).toContain("Budget exceeded");
	});

	test("allows the configured max turn and blocks the next one", async () => {
		const { ctx, getHook } = createPluginContext({ max_turns: 1 });

		await plugin.setup(ctx);
		const hook = getHook();

		await expect(hook.handler(createHookContext({ turnCount: 1 }))).resolves.toBeUndefined();
		await expect(hook.handler(createHookContext({ turnCount: 2 }))).resolves.toEqual({
			action: "stop",
			reason: "Turn limit reached: 2 > 1",
		});
	});
});
