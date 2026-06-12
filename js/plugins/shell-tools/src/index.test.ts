import type { PluginContext, ToolDefinition, ToolHandler } from "@parel/plugin-sdk";
import { WORKSPACE_CAPABILITY, type WorkspaceCapability } from "@parel/workspace";
import { describe, expect, it, vi } from "vitest";
import type { ExecCapability } from "./index.js";
import shellToolsPlugin from "./index.js";

interface Harness {
	ctx: PluginContext;
	tools: Map<string, { def: ToolDefinition; handler: ToolHandler }>;
	run: ReturnType<typeof vi.fn>;
}

function makeHarness(opts: { root?: string; output?: string; config?: Record<string, unknown> }) {
	const root = opts.root ?? "/workspace/repo";
	const tools = new Map<string, { def: ToolDefinition; handler: ToolHandler }>();
	const run = vi.fn().mockResolvedValue(opts.output ?? "ok\n");

	const workspace: WorkspaceCapability = {
		async current() {
			return {
				id: "ws_1",
				identity: {},
				metadata: { root },
				root,
			};
		},
		async materialize() {
			return { root };
		},
		async root() {
			return root;
		},
		async export() {
			throw new Error("not implemented");
		},
		async metadata() {
			return { root };
		},
	};

	const exec: ExecCapability = { run };

	const ctx = {
		config: opts.config ?? {},
		store: {} as PluginContext["store"],
		inputs: {} as PluginContext["inputs"],
		model: {} as PluginContext["model"],
		log: { debug() {}, info() {}, warn() {}, error() {} },
		require<T>(name: string): T {
			if (name === WORKSPACE_CAPABILITY) return workspace as T;
			if (name === "exec") return exec as T;
			throw new Error(`capability not provided: ${name}`);
		},
		tool(def: ToolDefinition, handler: ToolHandler) {
			tools.set(def.name, { def, handler });
		},
		provide() {},
		hook() {},
		interrupt() {},
	} as unknown as PluginContext;

	return { ctx, tools, run } satisfies Harness;
}

describe("@parel/shell-tools", () => {
	it("runs shell commands from the workspace root", async () => {
		const h = makeHarness({ root: "/workspace/acme's repo" });
		await shellToolsPlugin.setup(h.ctx);

		const shell = h.tools.get("workspace_shell");
		expect(shell).toBeDefined();
		const result = await shell?.handler({ command: "pnpm test" }, {} as never);

		expect(result).toEqual({ content: "ok\n" });
		expect(h.run).toHaveBeenCalledWith("cd '/workspace/acme'\\''s repo' && pnpm test");
		expect(shell?.def.scheduling?.defaultMode).toBe("exclusive");
	});

	it("rejects missing commands", async () => {
		const h = makeHarness({});
		await shellToolsPlugin.setup(h.ctx);

		await expect(
			h.tools.get("workspace_shell")?.handler({ command: "   " }, {} as never),
		).rejects.toThrow("non-empty string");
	});

	it("truncates large command output", async () => {
		const h = makeHarness({
			config: { maxOutputBytes: 80 },
			output: "x".repeat(500),
		});
		await shellToolsPlugin.setup(h.ctx);

		const result = await h.tools
			.get("workspace_shell")
			?.handler({ command: "cat big" }, {} as never);

		expect(result).toMatchObject({
			truncated: true,
			originalByteLength: 500,
		});
		expect(result).toBeDefined();
		const content = typeof result === "string" ? result : (result?.content ?? "");
		expect(new TextEncoder().encode(content).byteLength).toBeLessThanOrEqual(80);
	});

	it("reports empty command output explicitly", async () => {
		const h = makeHarness({ output: "" });
		await shellToolsPlugin.setup(h.ctx);

		const result = await h.tools.get("workspace_shell")?.handler({ command: "true" }, {} as never);

		expect(result).toEqual({ content: "Command completed with no output." });
	});
});
