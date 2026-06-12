import type { HookContext, LifecycleEventType, PluginContext } from "@parel/plugin-sdk";
import { LifecycleEvent } from "@parel/plugin-sdk";
import { describe, expect, it } from "vitest";
import codingAgentPlugin from "./index.js";

function makeHarness(config: Record<string, unknown> = {}) {
	let contextBuild:
		| ((ctx: HookContext<typeof LifecycleEvent.ContextBuild>) => Promise<unknown>)
		| undefined;
	const ctx = {
		config,
		store: {} as PluginContext["store"],
		inputs: {} as PluginContext["inputs"],
		model: {} as PluginContext["model"],
		log: { debug() {}, info() {}, warn() {}, error() {} },
		hook(event: LifecycleEventType, handler: typeof contextBuild) {
			if (event === LifecycleEvent.ContextBuild) contextBuild = handler;
		},
		tool() {},
		provide() {},
		require() {
			throw new Error("no capabilities required");
		},
		interrupt() {},
	} as unknown as PluginContext;
	return {
		ctx,
		async run(system = "Base system") {
			if (!contextBuild) throw new Error("context hook not registered");
			return contextBuild({
				event: LifecycleEvent.ContextBuild,
				session: {} as never,
				store: {} as never,
				inputs: {} as never,
				tools: {} as never,
				system,
				messages: [],
			});
		},
	};
}

describe("@parel/coding-agent", () => {
	it("injects a coding agent profile into system context", async () => {
		const h = makeHarness({ name: "Repo Agent", extraInstructions: "Prefer pnpm." });
		await codingAgentPlugin.setup(h.ctx);

		const result = await h.run();

		expect(result).toMatchObject({
			action: "continue",
			mutations: {
				system: expect.stringContaining("<coding_agent_profile>"),
			},
		});
		const system = (result as { mutations: { system: string } }).mutations.system;
		expect(system).toContain("Base system");
		expect(system).toContain("Repo Agent");
		expect(system).toContain("workspace-relative");
		expect(system).toContain("forked subagents");
		expect(system).toContain("Request approval");
		expect(system).toContain("Prefer pnpm.");
	});

	it("can disable optional guidance sections", async () => {
		const h = makeHarness({
			enableForkGuidance: false,
			enableProcessGuidance: false,
			enablePortGuidance: false,
			enableGitGuidance: false,
			enableApprovalGuidance: false,
		});
		await codingAgentPlugin.setup(h.ctx);

		const result = await h.run("");
		const system = (result as { mutations: { system: string } }).mutations.system;

		expect(system).not.toContain("forked subagents");
		expect(system).not.toContain("background process");
		expect(system).not.toContain("Expose ports");
		expect(system).not.toContain("git status");
		expect(system).not.toContain("Request approval");
	});
});
