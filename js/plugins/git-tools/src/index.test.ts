import type { PluginContext, ToolDefinition, ToolHandler } from "@parel/plugin-sdk";
import { WORKSPACE_CAPABILITY, type WorkspaceCapability } from "@parel/workspace";
import { describe, expect, it, vi } from "vitest";
import type { ExecCapability } from "./index.js";
import gitToolsPlugin from "./index.js";

interface Harness {
	ctx: PluginContext;
	tools: Map<string, { def: ToolDefinition; handler: ToolHandler }>;
	run: ReturnType<typeof vi.fn>;
}

function makeHarness(opts: { root?: string; output?: string; config?: Record<string, unknown> }) {
	const root = opts.root ?? "/workspace/repo";
	const tools = new Map<string, { def: ToolDefinition; handler: ToolHandler }>();
	const run = vi.fn().mockResolvedValue(opts.output ?? "## main\n M src/app.ts\n");

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

describe("@parel/git-tools", () => {
	it("runs git status from the workspace root", async () => {
		const h = makeHarness({ root: "/workspace/acme's repo" });
		await gitToolsPlugin.setup(h.ctx);

		const status = h.tools.get("workspace_git_status");
		expect(status).toBeDefined();
		const result = await status?.handler({}, {} as never);

		expect(result).toEqual({ content: "## main\n M src/app.ts\n" });
		expect(h.run).toHaveBeenCalledWith(
			"cd '/workspace/acme'\\''s repo' && git status --short --branch",
		);
		expect(status?.def.scheduling?.defaultMode).toBe("parallel");
	});

	it("runs git diff for a workspace-relative path", async () => {
		const h = makeHarness({ output: "diff --git a/src/app.ts b/src/app.ts\n" });
		await gitToolsPlugin.setup(h.ctx);

		const diff = h.tools.get("workspace_git_diff");
		const result = await diff?.handler({ path: "src/app.ts", staged: true }, {} as never);

		expect(result).toMatchObject({
			content: "diff --git a/src/app.ts b/src/app.ts\n",
			refs: [{ type: "workspace_path", path: "src/app.ts" }],
		});
		expect(h.run).toHaveBeenCalledWith("cd '/workspace/repo' && git diff --staged -- 'src/app.ts'");
		expect(diff?.def.scheduling?.defaultMode).toBe("parallel");
	});

	it("lists branches and switches branches", async () => {
		const h = makeHarness({ output: "current: main\n* main\n  remotes/origin/main\n" });
		await gitToolsPlugin.setup(h.ctx);

		const branches = await h.tools.get("workspace_git_branches")?.handler({}, {} as never);
		expect(branches).toEqual({ content: "current: main\n* main\n  remotes/origin/main\n" });
		expect(h.run).toHaveBeenCalledWith(
			"cd '/workspace/repo' && printf 'current: '; git branch --show-current; git branch --all --no-color",
		);
		expect(h.tools.get("workspace_git_branches")?.def.scheduling?.defaultMode).toBe("parallel");

		await h.tools
			.get("workspace_git_switch_branch")
			?.handler({ branch: "feature/test", create: true }, {} as never);
		expect(h.run).toHaveBeenLastCalledWith(
			"cd '/workspace/repo' && git switch -c 'feature/test' && git status --short --branch",
		);
		expect(h.tools.get("workspace_git_switch_branch")?.def.scheduling?.defaultMode).toBe(
			"exclusive",
		);
	});

	it("commits staged changes or explicitly staged workspace paths", async () => {
		const h = makeHarness({ output: "[main abc123] update app\n" });
		await gitToolsPlugin.setup(h.ctx);

		const committed = await h.tools
			.get("workspace_git_commit")
			?.handler({ message: "update app", paths: ["src/app.ts", "package.json"] }, {} as never);

		expect(committed).toMatchObject({
			content: "[main abc123] update app\n",
			refs: [
				{ type: "workspace_path", path: "src/app.ts" },
				{ type: "workspace_path", path: "package.json" },
			],
		});
		expect(h.run).toHaveBeenCalledWith(
			"cd '/workspace/repo' && git add -- 'src/app.ts' 'package.json' && git commit -m 'update app' && git status --short --branch",
		);

		await h.tools
			.get("workspace_git_commit")
			?.handler({ message: "staged only", allowEmpty: true }, {} as never);
		expect(h.run).toHaveBeenLastCalledWith(
			"cd '/workspace/repo' && : && git commit -m 'staged only' --allow-empty && git status --short --branch",
		);
		expect(h.tools.get("workspace_git_commit")?.def.scheduling?.defaultMode).toBe("exclusive");
	});

	it("rejects absolute or escaping paths", async () => {
		const h = makeHarness({});
		await gitToolsPlugin.setup(h.ctx);

		await expect(
			h.tools.get("workspace_git_diff")?.handler({ path: "/etc" }, {} as never),
		).rejects.toThrow("workspace-relative");
		await expect(
			h.tools.get("workspace_git_diff")?.handler({ path: "../secret" }, {} as never),
		).rejects.toThrow("inside the workspace");
		await expect(
			h.tools
				.get("workspace_git_commit")
				?.handler({ message: "bad", paths: ["/etc"] }, {} as never),
		).rejects.toThrow("workspace-relative");
	});

	it("truncates large diff output", async () => {
		const h = makeHarness({ config: { maxOutputBytes: 80 }, output: "x".repeat(500) });
		await gitToolsPlugin.setup(h.ctx);

		const result = await h.tools.get("workspace_git_diff")?.handler({}, {} as never);

		expect(result).toMatchObject({ truncated: true, originalByteLength: 500 });
		expect(result).toBeDefined();
		const content = typeof result === "string" ? result : (result?.content ?? "");
		expect(new TextEncoder().encode(content).byteLength).toBeLessThanOrEqual(80);
	});
});
