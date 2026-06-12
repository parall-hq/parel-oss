import {
	type HookHandler,
	type InputQueueItem,
	LifecycleEvent,
	type Message,
	type PluginContext,
} from "@parel/plugin-sdk";
import { describe, expect, it, vi } from "vitest";
import steering from "./index.js";

function fakeInputs(items: InputQueueItem[] = []) {
	let store = [...items];
	return {
		drain(type: string) {
			const matched = store.filter((i) => i.type === type);
			store = store.filter((i) => i.type !== type);
			return matched;
		},
		peek(type: string) {
			return store.filter((i) => i.type === type);
		},
		push() {},
	};
}

function makeHarness() {
	const hooks = new Map<string, HookHandler<LifecycleEvent>>();
	const interrupt = vi.fn();
	const ctx = {
		config: {},
		store: {} as PluginContext["store"],
		inputs: fakeInputs(),
		log: { debug() {}, info() {}, warn() {}, error() {} },
		hook(event: string, handler: HookHandler<LifecycleEvent>) {
			hooks.set(event, handler);
		},
		tool() {},
		provide() {},
		require() {
			throw new Error("not provided");
		},
		interrupt,
	} as unknown as PluginContext;
	return { ctx, hooks, interrupt };
}

function steerItem(message: string): InputQueueItem {
	return { id: "s1", type: "steer", source: "user", timestamp: 0, payload: { message } };
}

describe("@parel/steering-immediate", () => {
	it("appends drained steer inputs as [Steering] user messages", async () => {
		const h = makeHarness();
		await steering.setup(h.ctx);
		const existing: Message[] = [{ role: "user", parts: [{ type: "text", text: "original" }] }];
		const inputs = fakeInputs([steerItem("go left")]);

		const out = await h.hooks.get(LifecycleEvent.ContextBuild)?.({
			system: "",
			messages: existing,
			inputs,
		} as never);
		const messages = (out as { mutations: { messages: Message[] } }).mutations.messages;
		expect(messages).toHaveLength(2);
		expect((messages[1].parts[0] as { text: string }).text).toBe("[Steering] go left");
		// inputs are consumed (drained)
		expect(inputs.peek("steer")).toHaveLength(0);
	});

	it("does nothing when there are no steer inputs", async () => {
		const h = makeHarness();
		await steering.setup(h.ctx);
		const out = await h.hooks.get(LifecycleEvent.ContextBuild)?.({
			system: "",
			messages: [],
			inputs: fakeInputs(),
		} as never);
		expect(out).toBeUndefined();
	});

	it("interrupts the step when an interrupt input is pending", async () => {
		const h = makeHarness();
		await steering.setup(h.ctx);
		const inputs = fakeInputs([
			{ id: "x", type: "interrupt", source: "user", timestamp: 0, payload: {} },
		]);
		await h.hooks.get(LifecycleEvent.StepStart)?.({ inputs } as never);
		expect(h.interrupt).toHaveBeenCalledOnce();
		expect(inputs.peek("interrupt")).toHaveLength(0);
	});

	it("does not interrupt without a pending interrupt", async () => {
		const h = makeHarness();
		await steering.setup(h.ctx);
		await h.hooks.get(LifecycleEvent.StepStart)?.({ inputs: fakeInputs() } as never);
		expect(h.interrupt).not.toHaveBeenCalled();
	});
});
