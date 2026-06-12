import type { PluginContext, ToolDefinition, ToolHandler } from "@parel/plugin-sdk";
import { WORKSPACE_CAPABILITY, type WorkspaceCapability } from "@parel/workspace";
import { describe, expect, it, vi } from "vitest";
import type { ExecCapability, FilesystemCapability } from "./index.js";
import editToolsPlugin from "./index.js";

interface Harness {
	ctx: PluginContext;
	tools: Map<string, { def: ToolDefinition; handler: ToolHandler }>;
	files: Map<string, string>;
	run: ReturnType<typeof vi.fn>;
}

function makeHarness(opts: { root?: string; files?: Record<string, string>; output?: string }) {
	const root = opts.root ?? "/workspace/repo";
	const files = new Map(Object.entries(opts.files ?? {}));
	const tools = new Map<string, { def: ToolDefinition; handler: ToolHandler }>();
	const run = vi.fn().mockResolvedValue(opts.output ?? " src/app.ts | 2 +-\n");

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

	const filesystem: FilesystemCapability = {
		async readFile(path) {
			const value = files.get(path);
			if (value === undefined) throw new Error(`missing file: ${path}`);
			return value;
		},
		async writeFile(path, content) {
			files.set(path, content);
		},
	};
	const exec: ExecCapability = { run };

	const ctx = {
		config: {},
		store: {} as PluginContext["store"],
		inputs: {} as PluginContext["inputs"],
		model: {} as PluginContext["model"],
		log: { debug() {}, info() {}, warn() {}, error() {} },
		require<T>(name: string): T {
			if (name === WORKSPACE_CAPABILITY) return workspace as T;
			if (name === "filesystem") return filesystem as T;
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

	return { ctx, tools, files, run } satisfies Harness;
}

describe("@parel/edit-tools", () => {
	it("applies a single exact replacement by default", async () => {
		const h = makeHarness({ files: { "/workspace/repo/src/app.ts": "hello world\n" } });
		await editToolsPlugin.setup(h.ctx);

		const edit = h.tools.get("workspace_edit_file");
		expect(edit).toBeDefined();
		const result = await edit?.handler(
			{ path: "src/app.ts", oldText: "world", newText: "parel" },
			{} as never,
		);

		expect(h.files.get("/workspace/repo/src/app.ts")).toBe("hello parel\n");
		expect(result).toMatchObject({
			content: "Replaced 1 occurrence(s) in src/app.ts; new size is 12 bytes.",
			fullContentRef: { type: "workspace_path", path: "src/app.ts" },
		});
		expect(edit?.def.scheduling?.defaultMode).toBe("exclusive");
	});

	it("rejects ambiguous replacements unless an expected count is supplied", async () => {
		const h = makeHarness({ files: { "/workspace/repo/src/app.ts": "x x x" } });
		await editToolsPlugin.setup(h.ctx);

		await expect(
			h.tools
				.get("workspace_edit_file")
				?.handler({ path: "src/app.ts", oldText: "x", newText: "y" }, {} as never),
		).rejects.toThrow("expected 1 replacement(s), found 3");
		expect(h.files.get("/workspace/repo/src/app.ts")).toBe("x x x");

		await h.tools
			.get("workspace_edit_file")
			?.handler(
				{ path: "src/app.ts", oldText: "x", newText: "y", expectedReplacements: 3 },
				{} as never,
			);
		expect(h.files.get("/workspace/repo/src/app.ts")).toBe("y y y");
	});

	it("rejects absolute or escaping paths", async () => {
		const h = makeHarness({ files: { "/workspace/repo/src/app.ts": "hello" } });
		await editToolsPlugin.setup(h.ctx);

		await expect(
			h.tools
				.get("workspace_edit_file")
				?.handler({ path: "/etc/passwd", oldText: "a", newText: "b" }, {} as never),
		).rejects.toThrow("workspace-relative");
		await expect(
			h.tools
				.get("workspace_edit_file")
				?.handler({ path: "../secret", oldText: "a", newText: "b" }, {} as never),
		).rejects.toThrow("inside the workspace");
	});

	it("rejects empty old text", async () => {
		const h = makeHarness({ files: { "/workspace/repo/src/app.ts": "hello" } });
		await editToolsPlugin.setup(h.ctx);

		await expect(
			h.tools
				.get("workspace_edit_file")
				?.handler({ path: "src/app.ts", oldText: "", newText: "b" }, {} as never),
		).rejects.toThrow("oldText must not be empty");
	});

	it("checks and applies unified patches with git apply", async () => {
		const h = makeHarness({ output: "Patch check passed.\n" });
		await editToolsPlugin.setup(h.ctx);

		const patch = "diff --git a/src/app.ts b/src/app.ts\n";
		const check = await h.tools
			.get("workspace_apply_patch")
			?.handler({ patch, checkOnly: true }, {} as never);

		expect(check).toEqual({ content: "Patch check passed.\n" });
		expect(h.run).toHaveBeenCalledWith(expect.stringContaining("cd '/workspace/repo' && sh -lc"));
		expect(h.run).toHaveBeenCalledWith(expect.stringContaining("git apply --check"));
		expect(h.run).toHaveBeenCalledWith(expect.not.stringContaining('git apply "$tmp" && git diff'));

		await h.tools.get("workspace_apply_patch")?.handler({ patch }, {} as never);
		expect(h.run).toHaveBeenLastCalledWith(expect.stringContaining("git diff --stat --"));
		expect(h.tools.get("workspace_apply_patch")?.def.scheduling?.defaultMode).toBe("exclusive");
	});

	it("rejects empty or oversized patches", async () => {
		const h = makeHarness({});
		h.ctx.config = { maxPatchBytes: 4 };
		await editToolsPlugin.setup(h.ctx);

		await expect(
			h.tools.get("workspace_apply_patch")?.handler({ patch: "" }, {} as never),
		).rejects.toThrow("patch must be a non-empty string");
		await expect(
			h.tools.get("workspace_apply_patch")?.handler({ patch: "12345" }, {} as never),
		).rejects.toThrow("max is 4");
	});
});
