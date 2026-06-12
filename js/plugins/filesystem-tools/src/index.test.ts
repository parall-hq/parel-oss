import type { PluginContext, ToolDefinition, ToolHandler } from "@parel/plugin-sdk";
import { WORKSPACE_CAPABILITY, type WorkspaceCapability } from "@parel/workspace";
import { describe, expect, it } from "vitest";
import type { FilesystemCapability } from "./index.js";
import filesystemToolsPlugin from "./index.js";

interface Harness {
	ctx: PluginContext;
	tools: Map<string, { def: ToolDefinition; handler: ToolHandler }>;
	files: Map<string, string>;
}

function makeHarness(opts: {
	root?: string;
	files?: Record<string, string>;
	config?: Record<string, unknown>;
}) {
	const root = opts.root ?? "/workspace/repo";
	const files = new Map(Object.entries(opts.files ?? {}));
	const tools = new Map<string, { def: ToolDefinition; handler: ToolHandler }>();

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
		async listDir(path) {
			const prefix = path.endsWith("/") ? path : `${path}/`;
			const entries = new Set<string>();
			for (const file of files.keys()) {
				if (!file.startsWith(prefix)) continue;
				const rest = file.slice(prefix.length);
				const [entry] = rest.split("/");
				if (entry) entries.add(entry);
			}
			return [...entries].sort();
		},
	};

	const ctx = {
		config: opts.config ?? {},
		store: {} as PluginContext["store"],
		inputs: {} as PluginContext["inputs"],
		model: {} as PluginContext["model"],
		log: { debug() {}, info() {}, warn() {}, error() {} },
		require<T>(name: string): T {
			if (name === WORKSPACE_CAPABILITY) return workspace as T;
			if (name === "filesystem") return filesystem as T;
			throw new Error(`capability not provided: ${name}`);
		},
		tool(def: ToolDefinition, handler: ToolHandler) {
			tools.set(def.name, { def, handler });
		},
		provide() {},
		hook() {},
		interrupt() {},
	} as unknown as PluginContext;

	return { ctx, tools, files } satisfies Harness;
}

describe("@parel/filesystem-tools", () => {
	it("reads workspace-relative files with refs and optional line ranges", async () => {
		const h = makeHarness({
			files: { "/workspace/repo/src/app.ts": "one\ntwo\nthree\nfour" },
		});
		await filesystemToolsPlugin.setup(h.ctx);

		const read = h.tools.get("workspace_read_file");
		expect(read).toBeDefined();
		const result = await read?.handler(
			{ path: "src/app.ts", startLine: 2, endLine: 3 },
			{} as never,
		);

		expect(result).toMatchObject({
			content: "two\nthree",
			fullContentRef: { type: "workspace_path", path: "src/app.ts" },
			refs: [{ type: "workspace_path", path: "src/app.ts" }],
		});
		expect(read?.def.scheduling?.defaultMode).toBe("parallel");
	});

	it("truncates large reads and preserves original byte length", async () => {
		const h = makeHarness({
			config: { maxReadBytes: 80 },
			files: { "/workspace/repo/large.txt": "x".repeat(500) },
		});
		await filesystemToolsPlugin.setup(h.ctx);

		const result = await h.tools
			.get("workspace_read_file")
			?.handler({ path: "large.txt" }, {} as never);

		expect(result).toMatchObject({
			truncated: true,
			originalByteLength: 500,
			fullContentRef: { type: "workspace_path", path: "large.txt" },
		});
		expect(result).toBeDefined();
		const content = typeof result === "string" ? result : (result?.content ?? "");
		expect(new TextEncoder().encode(content).byteLength).toBeLessThanOrEqual(80);
	});

	it("lists and writes inside the workspace", async () => {
		const h = makeHarness({
			files: { "/workspace/repo/src/app.ts": "hello" },
		});
		await filesystemToolsPlugin.setup(h.ctx);

		const list = await h.tools.get("workspace_list_dir")?.handler({ path: "src" }, {} as never);
		expect(JSON.parse(String(list))).toEqual({ path: "src", entries: ["app.ts"] });

		const write = await h.tools
			.get("workspace_write_file")
			?.handler({ path: "src/new.ts", content: "new content" }, {} as never);
		expect(write).toBe("Wrote 11 bytes to src/new.ts.");
		expect(h.files.get("/workspace/repo/src/new.ts")).toBe("new content");
	});

	it("rejects absolute or escaping paths", async () => {
		const h = makeHarness({
			files: { "/workspace/repo/src/app.ts": "hello" },
		});
		await filesystemToolsPlugin.setup(h.ctx);

		await expect(
			h.tools.get("workspace_read_file")?.handler({ path: "/etc/passwd" }, {} as never),
		).rejects.toThrow("workspace-relative");
		await expect(
			h.tools.get("workspace_read_file")?.handler({ path: "../secret.txt" }, {} as never),
		).rejects.toThrow("inside the workspace");
	});
});
