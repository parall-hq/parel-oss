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

// In-memory InstanceStore with real cas() semantics; share one between two
// harnesses to simulate sibling sessions of the same agent instance.
function makeInstanceStore() {
	const rows = new Map<string, { value: unknown; version: number }>();
	return {
		rows,
		async get<T>(key: string) {
			const row = rows.get(key);
			return row ? { value: row.value as T, version: row.version } : null;
		},
		async set<T>(key: string, value: T) {
			rows.set(key, { value, version: (rows.get(key)?.version ?? 0) + 1 });
		},
		async delete(key: string) {
			rows.delete(key);
		},
		async list(prefix = "") {
			return [...rows.keys()].filter((key) => key.startsWith(prefix));
		},
		async cas<T>(key: string, expectedVersion: number | null, value: T) {
			const current = rows.get(key)?.version ?? null;
			if (current !== expectedVersion) return false;
			rows.set(key, { value, version: (current ?? 0) + 1 });
			return true;
		},
		async casDelete(key: string, expectedVersion: number) {
			const current = rows.get(key)?.version ?? null;
			if (current !== expectedVersion) return false;
			rows.delete(key);
			return true;
		},
	};
}

function makeHarness(opts: {
	config?: Record<string, unknown>;
	storeValues?: Map<string, unknown>;
	exec?: ExecCapability;
	instanceStore?: ReturnType<typeof makeInstanceStore>;
}): Harness {
	const provided = new Map<string, unknown>();
	const tools = new Map<string, { def: ToolDefinition; handler: ToolHandler }>();
	const storeValues = opts.storeValues ?? new Map<string, unknown>();

	const ctx = {
		config: opts.config ?? {},
		store: makeStore(storeValues),
		instanceStore: opts.instanceStore,
		instance: opts.instanceStore ? { key: "main", ephemeral: false } : undefined,
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

describe("instance mode (ctx.instanceStore present)", () => {
	const gitConfig = {
		identity: { type: "git", repo: "https://github.com/acme/app.git" },
		workspaceId: "ws_shared",
	};

	function capability(h: Harness): WorkspaceCapability {
		return h.provided.get(WORKSPACE_CAPABILITY) as WorkspaceCapability;
	}

	it("a sibling session sees the root materialized by another", async () => {
		const istore = makeInstanceStore();
		const exec: ExecCapability = {
			run: vi.fn(
				async (cmd: string) => `__PAREL_WORKSPACE_OK__:${rootFromMaterializeCommand(cmd)}`,
			),
		};
		const hA = makeHarness({ config: gitConfig, exec, instanceStore: istore });
		const hB = makeHarness({ config: gitConfig, exec, instanceStore: istore });
		await workspacePlugin.setup(hA.ctx);
		await workspacePlugin.setup(hB.ctx);

		await capability(hA).materialize();
		// B reads the authoritative handle: root present, no second clone needed.
		const handle = await capability(hB).current();
		expect(handle?.root).toMatch(/^\/workspace\/app-/);
		const result = await capability(hB).materialize();
		expect(result.root).toMatch(/^\/workspace\/app-/);
		expect(exec.run).toHaveBeenCalledTimes(1); // only A's clone ran
	});

	it("losing the save race adopts the sibling's handle", async () => {
		const istore = makeInstanceStore();
		const exec: ExecCapability = {
			run: vi.fn(
				async (cmd: string) => `__PAREL_WORKSPACE_OK__:${rootFromMaterializeCommand(cmd)}`,
			),
		};
		const hA = makeHarness({ config: gitConfig, exec, instanceStore: istore });
		const hB = makeHarness({ config: gitConfig, exec, instanceStore: istore });
		await workspacePlugin.setup(hA.ctx);
		await workspacePlugin.setup(hB.ctx);

		// Both read (version=null), then A saves first — B's save must adopt.
		const a = capability(hA);
		const b = capability(hB);
		await a.current();
		await b.current();
		// A materializes (saves root); B then materializes concurrently-ish.
		await a.materialize();
		const result = await b.materialize();
		expect(result.root).toMatch(/^\/workspace\/app-/);
		const entry = await istore.get<WorkspaceHandle>("current");
		expect((entry?.value as WorkspaceHandle).root).toMatch(/^\/workspace\/app-/);
	});

	it("migrates a legacy per-session handle into the instance store", async () => {
		const istore = makeInstanceStore();
		const storeValues = new Map<string, unknown>([
			[
				"current",
				{
					id: "ws_legacy",
					identity: { type: "git", repo: "https://github.com/acme/app.git" },
					metadata: { root: "/tmp/parel/workspaces/ws_legacy" },
					root: "/tmp/parel/workspaces/ws_legacy",
				},
			],
		]);
		const h = makeHarness({ config: gitConfig, storeValues, instanceStore: istore });
		await workspacePlugin.setup(h.ctx);

		const handle = await capability(h).current();
		expect(handle?.id).toBe("ws_legacy");
		expect(handle?.root).toBe("/tmp/parel/workspaces/ws_legacy");
		// Promoted to the instance store; session-store copy cleaned up.
		expect(await istore.get("current")).not.toBeNull();
		expect(storeValues.has("current")).toBe(false);
	});
});
