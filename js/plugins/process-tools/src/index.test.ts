import type { PluginContext, ToolDefinition, ToolHandler } from "@parel/plugin-sdk";
import { LifecycleEvent } from "@parel/plugin-sdk";
import { WORKSPACE_CAPABILITY, type WorkspaceCapability } from "@parel/workspace";
import { describe, expect, it, vi } from "vitest";
import type { ProcessCapability, ProcessHandle } from "./index.js";
import processToolsPlugin from "./index.js";

interface Harness {
	ctx: PluginContext;
	tools: Map<string, { def: ToolDefinition; handler: ToolHandler }>;
	hooks: Map<string, (hookCtx: unknown) => Promise<unknown>>;
	records: Map<string, ProcessHandle>;
	processes: ProcessCapability;
	start: ReturnType<typeof vi.fn>;
	stop: ReturnType<typeof vi.fn>;
}

function makeHarness(opts: { root?: string } = {}) {
	const root = opts.root ?? "/workspace/repo";
	const tools = new Map<string, { def: ToolDefinition; handler: ToolHandler }>();
	const hooks = new Map<string, (hookCtx: unknown) => Promise<unknown>>();
	const records = new Map<string, ProcessHandle>();

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

	const start = vi.fn(async (command: string, startOpts?: { cwd?: string }) => {
		const record: ProcessHandle = {
			id: "proc_1",
			pid: 123,
			command,
			...(startOpts?.cwd ? { cwd: startOpts.cwd } : {}),
			stdoutPath: "/tmp/parel/processes/proc_1/stdout.log",
			stderrPath: "/tmp/parel/processes/proc_1/stderr.log",
			startedAt: "now",
			status: "running",
		};
		records.set(record.id, record);
		return record;
	});

	const stop = vi.fn(async (processId: string) => {
		const process = records.get(processId);
		if (!process) throw new Error(`unknown process: ${processId}`);
		const stopped = { ...process, status: "stopped" as const };
		records.set(processId, stopped);
		return { stopped: true, process: stopped };
	});

	const processes: ProcessCapability = {
		start,
		async list() {
			return [...records.values()];
		},
		async tail(processId) {
			if (!records.has(processId)) throw new Error(`unknown process: ${processId}`);
			return {
				stdout: "ready\n",
				stderr: "",
				stdoutPath: "/tmp/parel/processes/proc_1/stdout.log",
				stderrPath: "/tmp/parel/processes/proc_1/stderr.log",
			};
		},
		stop,
	};

	const ctx = {
		config: {},
		store: {} as PluginContext["store"],
		inputs: {} as PluginContext["inputs"],
		model: {} as PluginContext["model"],
		log: { debug() {}, info() {}, warn() {}, error() {} },
		require<T>(name: string): T {
			if (name === WORKSPACE_CAPABILITY) return workspace as T;
			if (name === "process") return processes as T;
			throw new Error(`capability not provided: ${name}`);
		},
		tool(def: ToolDefinition, handler: ToolHandler) {
			tools.set(def.name, { def, handler });
		},
		provide() {},
		hook(event: string, handler: (hookCtx: unknown) => Promise<unknown>) {
			hooks.set(event, handler);
		},
		interrupt() {},
	} as unknown as PluginContext;

	return { ctx, tools, hooks, records, processes, start, stop } satisfies Harness;
}

describe("@parel/process-tools", () => {
	it("starts background processes from a workspace-relative cwd", async () => {
		const h = makeHarness({ root: "/workspace/acme" });
		await processToolsPlugin.setup(h.ctx);

		const start = h.tools.get("workspace_start_process");
		expect(start).toBeDefined();
		const result = await start?.handler(
			{ command: "pnpm dev", path: "apps/web", timeoutMs: 120000 },
			{} as never,
		);

		expect(h.start).toHaveBeenCalledWith("pnpm dev", {
			cwd: "/workspace/acme/apps/web",
			timeoutMs: 120000,
		});
		expect(result).toMatchObject({
			content: expect.stringContaining("Started process proc_1"),
			refs: [
				{ type: "sandbox_path", path: "/tmp/parel/processes/proc_1/stdout.log" },
				{ type: "sandbox_path", path: "/tmp/parel/processes/proc_1/stderr.log" },
			],
		});
	});

	it("lists, tails, and stops processes", async () => {
		const h = makeHarness();
		await processToolsPlugin.setup(h.ctx);
		await h.tools.get("workspace_start_process")?.handler({ command: "pnpm dev" }, {} as never);

		const list = await h.tools.get("workspace_list_processes")?.handler({}, {} as never);
		expect(JSON.parse(String(list))).toEqual([
			expect.objectContaining({ id: "proc_1", status: "running" }),
		]);

		const tail = await h.tools
			.get("workspace_tail_process")
			?.handler({ processId: "proc_1" }, {} as never);
		expect(tail).toMatchObject({
			content: "stdout:\nready\n\n\nstderr: <empty>",
			refs: [
				{ type: "sandbox_path", path: "/tmp/parel/processes/proc_1/stdout.log" },
				{ type: "sandbox_path", path: "/tmp/parel/processes/proc_1/stderr.log" },
			],
		});

		const stop = await h.tools
			.get("workspace_stop_process")
			?.handler({ processId: "proc_1" }, {} as never);
		expect(stop).toBe("Stopped process proc_1.");
	});

	it("stops every running process when the session is stopped", async () => {
		const h = makeHarness();
		await processToolsPlugin.setup(h.ctx);
		const handle = (id: string, status: ProcessHandle["status"]): ProcessHandle => ({
			id,
			pid: 1,
			command: "sleep 600",
			stdoutPath: `/tmp/${id}/stdout.log`,
			stderrPath: `/tmp/${id}/stderr.log`,
			startedAt: "earlier",
			status,
		});
		h.records.set("proc_old", handle("proc_old", "running"));
		h.records.set("proc_new", handle("proc_new", "running"));
		h.records.set("proc_done", handle("proc_done", "stopped"));
		h.records.set("proc_gone", handle("proc_gone", "unknown"));
		h.stop.mockImplementationOnce(async () => {
			throw new Error("sandbox unreachable");
		});

		// One failed stop must not keep the others running or fail the hook.
		await expect(
			h.hooks.get(LifecycleEvent.SessionStop)?.({ reason: "Stopped from the console" }),
		).resolves.toBeUndefined();

		expect(h.stop.mock.calls.map(([id]) => id).sort()).toEqual(["proc_new", "proc_old"]);
	});

	it("rejects escaping working directories", async () => {
		const h = makeHarness();
		await processToolsPlugin.setup(h.ctx);

		await expect(
			h.tools
				.get("workspace_start_process")
				?.handler({ command: "pnpm dev", path: "../outside" }, {} as never),
		).rejects.toThrow("inside the workspace");
	});
});
