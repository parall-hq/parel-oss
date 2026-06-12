import type { PluginContext, ToolDefinition, ToolHandler } from "@parel/plugin-sdk";
import { WORKSPACE_CAPABILITY, type WorkspaceCapability } from "@parel/workspace";
import { describe, expect, it, vi } from "vitest";
import type { ExecCapability } from "./index.js";
import searchToolsPlugin from "./index.js";

interface Harness {
	ctx: PluginContext;
	tools: Map<string, { def: ToolDefinition; handler: ToolHandler }>;
	run: ReturnType<typeof vi.fn>;
}

function makeHarness(opts: { root?: string; output?: string; config?: Record<string, unknown> }) {
	const root = opts.root ?? "/workspace/repo";
	const tools = new Map<string, { def: ToolDefinition; handler: ToolHandler }>();
	const run = vi.fn().mockResolvedValue(opts.output ?? "src/app.ts:1:needle\n");

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

describe("@parel/search-tools", () => {
	it("runs workspace-relative grep and returns path refs", async () => {
		const h = makeHarness({ root: "/workspace/acme's repo" });
		await searchToolsPlugin.setup(h.ctx);

		const search = h.tools.get("workspace_search_text");
		expect(search).toBeDefined();
		const result = await search?.handler(
			{ query: "needle", path: "src", maxMatches: 25 },
			{} as never,
		);

		expect(result).toMatchObject({
			content: "src/app.ts:1:needle\n",
			refs: [{ type: "workspace_path", path: "src", metadata: { query: "needle" } }],
		});
		expect(h.run).toHaveBeenCalledWith(
			"cd '/workspace/acme'\\''s repo' && grep -RInI --exclude-dir=.git -- 'needle' 'src' | head -n 25 || true",
		);
		expect(search?.def.scheduling?.defaultMode).toBe("parallel");
	});

	it("reports no matches explicitly", async () => {
		const h = makeHarness({ output: "" });
		await searchToolsPlugin.setup(h.ctx);

		const result = await h.tools
			.get("workspace_search_text")
			?.handler({ query: "missing" }, {} as never);

		expect(result).toMatchObject({
			content: "No matches.",
			refs: [{ type: "workspace_path", path: ".", metadata: { query: "missing" } }],
		});
	});

	it("finds files by pattern", async () => {
		const h = makeHarness({ output: "src/app.ts\nsrc/index.ts\n" });
		await searchToolsPlugin.setup(h.ctx);

		const result = await h.tools
			.get("workspace_find_files")
			?.handler({ pattern: "*.ts", path: "src", maxMatches: 20 }, {} as never);

		expect(result).toMatchObject({
			content: "src/app.ts\nsrc/index.ts\n",
			refs: [{ type: "workspace_path", path: "src", metadata: { pattern: "*.ts" } }],
		});
		expect(h.run).toHaveBeenCalledWith(
			"cd '/workspace/repo' && find 'src' -path '*/.git' -prune -o -type f -name '*.ts' -print | head -n 20 || true",
		);
		expect(h.tools.get("workspace_find_files")?.def.scheduling?.defaultMode).toBe("parallel");
	});

	it("rejects absolute or escaping paths", async () => {
		const h = makeHarness({});
		await searchToolsPlugin.setup(h.ctx);

		await expect(
			h.tools.get("workspace_search_text")?.handler({ query: "needle", path: "/etc" }, {} as never),
		).rejects.toThrow("workspace-relative");
		await expect(
			h.tools
				.get("workspace_search_text")
				?.handler({ query: "needle", path: "../secret" }, {} as never),
		).rejects.toThrow("inside the workspace");
		await expect(
			h.tools.get("workspace_find_files")?.handler({ pattern: "*.ts", path: "/etc" }, {} as never),
		).rejects.toThrow("workspace-relative");
	});

	it("truncates large search output", async () => {
		const h = makeHarness({ config: { maxOutputBytes: 80 }, output: "x".repeat(500) });
		await searchToolsPlugin.setup(h.ctx);

		const result = await h.tools
			.get("workspace_search_text")
			?.handler({ query: "needle" }, {} as never);

		expect(result).toMatchObject({ truncated: true, originalByteLength: 500 });
		expect(result).toBeDefined();
		const content = typeof result === "string" ? result : (result?.content ?? "");
		expect(new TextEncoder().encode(content).byteLength).toBeLessThanOrEqual(80);
	});
});
