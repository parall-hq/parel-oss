import type { PluginContext, SessionStore, ToolDefinition, ToolHandler } from "@parel/plugin-sdk";
import { describe, expect, it, vi } from "vitest";
import workspacePlugin, {
	type ExecCapability,
	WORKSPACE_CAPABILITY,
	type WorkspaceCapability,
	type WorkspaceHandle,
} from "./index.js";

interface Harness {
	ctx: PluginContext;
	provided: Map<string, unknown>;
	tools: Map<string, { def: ToolDefinition; handler: ToolHandler }>;
	storeValues: Map<string, unknown>;
	getTool(name: string): { def: ToolDefinition; handler: ToolHandler };
}

function makeStore(values = new Map<string, unknown>()): SessionStore {
	return {
		async get<T = unknown>(key: string): Promise<T | null> {
			return (values.get(key) as T | undefined) ?? null;
		},
		async set<T = unknown>(key: string, value: T): Promise<void> {
			values.set(key, value);
		},
		async delete(key: string): Promise<void> {
			values.delete(key);
		},
		async list(prefix = ""): Promise<string[]> {
			return [...values.keys()].filter((key) => key.startsWith(prefix));
		},
	};
}

function makeHarness(opts: {
	config?: Record<string, unknown>;
	storeValues?: Map<string, unknown>;
	exec?: ExecCapability;
}): Harness {
	const provided = new Map<string, unknown>();
	const tools = new Map<string, { def: ToolDefinition; handler: ToolHandler }>();
	const storeValues = opts.storeValues ?? new Map<string, unknown>();

	const ctx = {
		config: opts.config ?? {},
		store: makeStore(storeValues),
		inputs: {} as PluginContext["inputs"],
		model: {} as PluginContext["model"],
		log: { debug() {}, info() {}, warn() {}, error() {} },
		require<T>(name: string): T {
			if (name === "exec" && opts.exec) return opts.exec as T;
			throw new Error(`capability not provided: ${name}`);
		},
		provide(name: string, implementation: unknown) {
			provided.set(name, implementation);
		},
		tool(def: ToolDefinition, handler: ToolHandler) {
			tools.set(def.name, { def, handler });
		},
		hook() {},
		interrupt() {},
	} as unknown as PluginContext;

	return {
		ctx,
		provided,
		tools,
		storeValues,
		getTool(name: string) {
			const tool = tools.get(name);
			if (!tool) throw new Error(`tool not registered: ${name}`);
			return tool;
		},
	};
}

function rootFromMaterializeCommand(command: string): string {
	const match = command.match(/root='\\''([^']+)'\\''/);
	if (!match?.[1]) throw new Error(`root not found in command: ${command}`);
	return match[1];
}

function outputPathFromExportCommand(command: string): string {
	const match = command.match(/outfile='\\''([^']+)'\\''/);
	if (!match?.[1]) throw new Error(`outfile not found in command: ${command}`);
	return match[1];
}

describe("@parel/workspace", () => {
	it("provides the current workspace from config and stores it in the plugin store", async () => {
		const h = makeHarness({
			config: {
				workspaceId: "ws_repo",
				identity: { sourceKind: "git", repo: "github.com/acme/repo" },
				root: "/workspace/repo",
			},
		});
		await workspacePlugin.setup(h.ctx);

		const workspace = h.provided.get(WORKSPACE_CAPABILITY) as WorkspaceCapability;
		await expect(workspace.root()).resolves.toBe("/workspace/repo");
		await expect(workspace.current()).resolves.toMatchObject({
			id: "ws_repo",
			root: "/workspace/repo",
			identity: { sourceKind: "git", repo: "github.com/acme/repo" },
		});
		expect(h.storeValues.get("current")).toMatchObject({ id: "ws_repo" });

		const toolResult = await h.getTool("workspace_current").handler({}, {} as never);
		expect(toolResult).toContain("github.com/acme/repo");
	});

	it("restores the current workspace from plugin store before reading config", async () => {
		const stored: WorkspaceHandle = {
			id: "ws_stored",
			identity: { sourceKind: "git", repo: "github.com/acme/stored" },
			metadata: { root: "/workspace/stored" },
			root: "/workspace/stored",
		};
		const h = makeHarness({
			storeValues: new Map([["current", stored]]),
			config: {
				workspaceId: "ws_config",
				root: "/workspace/config",
			},
		});
		await workspacePlugin.setup(h.ctx);

		const workspace = h.provided.get(WORKSPACE_CAPABILITY) as WorkspaceCapability;
		await expect(workspace.current()).resolves.toMatchObject({ id: "ws_stored" });
		await expect(workspace.root()).resolves.toBe("/workspace/stored");
	});

	it("fails materialize clearly when no root is available", async () => {
		const h = makeHarness({ config: { workspaceId: "ws_empty", identity: {} } });
		await workspacePlugin.setup(h.ctx);

		const workspace = h.provided.get(WORKSPACE_CAPABILITY) as WorkspaceCapability;
		await expect(workspace.materialize()).rejects.toThrow("Workspace is not materialized");
	});

	it("materializes a git workspace identity into the sandbox and updates plugin store", async () => {
		const exec = {
			run: vi.fn().mockImplementation((command: string) => {
				const root = rootFromMaterializeCommand(command);
				return Promise.resolve(`cloned\n__PAREL_WORKSPACE_OK__:${root}\n`);
			}),
		};
		const h = makeHarness({
			exec,
			config: {
				workspaceId: "ws_git",
				identity: { sourceKind: "git", repo: "git@github.com:acme/repo.git", branch: "main" },
				baseDir: "/workspace",
			},
		});
		await workspacePlugin.setup(h.ctx);

		const workspace = h.provided.get(WORKSPACE_CAPABILITY) as WorkspaceCapability;
		const result = await workspace.materialize();

		expect(result.root).toMatch(/^\/workspace\/repo-/);
		expect(exec.run).toHaveBeenCalledWith(expect.stringContaining("git clone"));
		expect(exec.run).toHaveBeenCalledWith(expect.stringContaining("git@github.com:acme/repo.git"));
		expect(h.storeValues.get("current")).toMatchObject({
			id: "ws_git",
			root: result.root,
			metadata: expect.objectContaining({
				root: result.root,
				branch: "main",
				materializedBy: "@parel/workspace",
				materializedAt: expect.any(String),
			}),
		});
		await expect(workspace.root()).resolves.toBe(result.root);
	});

	it("exports a workspace diff as a sandbox path ref", async () => {
		const exec = {
			run: vi.fn().mockImplementation((command: string) => {
				const outputPath = outputPathFromExportCommand(command);
				return Promise.resolve(`done\n__PAREL_WORKSPACE_EXPORT__:${outputPath}\n`);
			}),
		};
		const h = makeHarness({
			exec,
			config: {
				workspaceId: "ws_1",
				identity: { sourceKind: "git", repo: "github.com/acme/repo" },
				root: "/workspace/repo",
			},
		});
		await workspacePlugin.setup(h.ctx);

		const workspace = h.provided.get(WORKSPACE_CAPABILITY) as WorkspaceCapability;
		await expect(workspace.export({ kind: "patch" })).resolves.toEqual({
			ref: {
				type: "sandbox_path",
				path: "/tmp/parel/workspaces/ws_1/workspace.patch",
				mediaType: "text/x-patch",
				metadata: { kind: "patch", workspaceId: "ws_1", root: "/workspace/repo" },
			},
		});
		expect(exec.run).toHaveBeenCalledWith(
			expect.stringContaining("git diff --binary --full-index"),
		);
	});

	it("registers materialize and export tools", async () => {
		const exec = {
			run: vi.fn().mockImplementation((command: string) => {
				const outputPath = outputPathFromExportCommand(command);
				return Promise.resolve(`done\n__PAREL_WORKSPACE_EXPORT__:${outputPath}\n`);
			}),
		};
		const h = makeHarness({
			exec,
			config: {
				workspaceId: "ws_1",
				identity: { sourceKind: "git", repo: "github.com/acme/repo" },
				root: "/workspace/repo",
			},
		});
		await workspacePlugin.setup(h.ctx);

		await expect(
			h.getTool("workspace_materialize").handler({}, {} as never),
		).resolves.toMatchObject({
			content: "Workspace materialized at /workspace/repo.",
			refs: [{ type: "sandbox_path", path: "/workspace/repo" }],
		});
		await expect(
			h.getTool("workspace_export").handler({ kind: "diff" }, {} as never),
		).resolves.toMatchObject({
			content: "Workspace export created at /tmp/parel/workspaces/ws_1/workspace.diff.",
			refs: [
				{
					type: "sandbox_path",
					path: "/tmp/parel/workspaces/ws_1/workspace.diff",
					mediaType: "text/x-diff",
				},
			],
		});
	});
});
