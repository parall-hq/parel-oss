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

function createPluginContext(config: Record<string, unknown>, store = new Map<string, unknown>()) {
	let captured: CapturedHook | undefined;
	const warnings: string[] = [];
	const ctx = {
		config,
		store: {
			get: async (key: string) => store.get(key) ?? null,
			set: async (key: string, value: unknown) => {
				store.set(key, value);
			},
		},
		log: { warn: (message: string) => warnings.push(message) },
		hook: (event: LifecycleEventType, handler: CapturedHook["handler"]) => {
			captured = { event, handler };
		},
	} as unknown as PluginContext;

	return {
		ctx,
		warnings,
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

	test("warns once per session when tokens cost nothing", async () => {
		const store = new Map<string, unknown>();
		const { ctx, warnings, getHook } = createPluginContext({ max_usd: 40 }, store);

		await plugin.setup(ctx);
		const hook = getHook();
		await expect(hook.handler(createHookContext({ totalTokens: 1200 }))).resolves.toBeUndefined();
		await hook.handler(createHookContext({ totalTokens: 2400 }));

		expect(warnings).toEqual([
			"Session used 1200 tokens at $0: the model has no price, so max_usd ($40) cannot take effect.",
		]);

		// A fresh plugin runtime for the same session reads the flag from the session store.
		const again = createPluginContext({ max_usd: 40 }, store);
		await plugin.setup(again.ctx);
		await again.getHook().handler(createHookContext({ totalTokens: 3600 }));
		expect(again.warnings).toEqual([]);
	});

	test("does not warn before any usage or when the model is priced", async () => {
		const { ctx, warnings, getHook } = createPluginContext({ max_usd: 40 });

		await plugin.setup(ctx);
		const hook = getHook();
		await hook.handler(createHookContext());
		await hook.handler(createHookContext({ totalTokens: 1200, totalCostUsd: 0.01 }));

		expect(warnings).toEqual([]);
	});
});
