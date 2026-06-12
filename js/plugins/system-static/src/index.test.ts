import type { HookHandler, LifecycleEvent, PluginContext } from "@parel/plugin-sdk";
import { describe, expect, it } from "vitest";
import systemStatic from "./index.js";

function makeHarness(config: Record<string, unknown>) {
	const hooks = new Map<string, HookHandler<LifecycleEvent>>();
	const ctx = {
		config,
		store: {} as PluginContext["store"],
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
	return { ctx, hooks };
}

describe("@parel/system-static", () => {
	it("injects the configured prompt into an empty system", async () => {
		const h = makeHarness({ prompt: "You are helpful." });
		await systemStatic.setup(h.ctx);
		const out = await h.hooks.get("context:build")?.({ system: "", messages: [] } as never);
		expect((out as { mutations: { system: string } }).mutations.system).toBe("You are helpful.");
	});

	it("appends to an existing system prompt", async () => {
		const h = makeHarness({ prompt: "Be concise." });
		await systemStatic.setup(h.ctx);
		const out = await h.hooks.get("context:build")?.({ system: "BASE", messages: [] } as never);
		expect((out as { mutations: { system: string } }).mutations.system).toBe("BASE\n\nBe concise.");
	});

	it("registers no hook when no prompt is configured", async () => {
		const h = makeHarness({});
		await systemStatic.setup(h.ctx);
		expect(h.hooks.get("context:build")).toBeUndefined();
	});
});
