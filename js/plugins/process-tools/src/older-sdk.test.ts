import type { PluginContext } from "@parel/plugin-sdk";
import { WORKSPACE_CAPABILITY } from "@parel/workspace";
import { expect, it, vi } from "vitest";
import type { ProcessCapability, ProcessHandle } from "./index.js";
import processToolsPlugin from "./index.js";

// A plugin graph holds one copy of each package: next to a plugin that pins an older
// @parel/plugin-sdk, this plugin runs with that copy, whose LifecycleEvent has no SessionStop.
vi.mock("@parel/plugin-sdk", async (importOriginal) => {
	const sdk = await importOriginal<typeof import("@parel/plugin-sdk")>();
	const { SessionStop: _missing, ...older } = sdk.LifecycleEvent;
	return { ...sdk, LifecycleEvent: older };
});

it("still stops running processes on session:stop with an older SDK in the graph", async () => {
	const hooks = new Map<string, (hookCtx: unknown) => Promise<unknown>>();
	const running: ProcessHandle = {
		id: "proc_1",
		pid: 1,
		command: "pnpm dev",
		stdoutPath: "/tmp/out",
		stderrPath: "/tmp/err",
		startedAt: "earlier",
		status: "running",
	};
	const stop = vi.fn(async () => ({
		stopped: true,
		process: { ...running, status: "stopped" as const },
	}));
	const processes = { list: async () => [running], stop } as unknown as ProcessCapability;
	const ctx = {
		require: (name: string) =>
			name === WORKSPACE_CAPABILITY ? { root: async () => "/w" } : processes,
		tool: () => {},
		hook: (event: string, handler: (hookCtx: unknown) => Promise<unknown>) =>
			hooks.set(event, handler),
		log: { warn: () => {} },
	} as unknown as PluginContext;

	await processToolsPlugin.setup(ctx);
	await hooks.get("session:stop")?.({ reason: "Stopped from the console" });
	expect(stop).toHaveBeenCalledWith("proc_1");
});
