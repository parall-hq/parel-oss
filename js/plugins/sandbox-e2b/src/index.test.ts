import { PAREL_SANDBOX_CAPABILITY, type SandboxCapability } from "@parel/capability-sandbox";
import {
	LifecycleEvent,
	type LifecycleEventType,
	type PluginContext,
	type ToolDefinition,
	type ToolHandler,
} from "@parel/plugin-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SandboxPortsCapability, SandboxProcessCapability } from "./index.js";
import sandboxE2bPlugin from "./index.js";

const sandboxMock = vi.hoisted(() => ({
	create: vi.fn(),
	connect: vi.fn(),
}));

vi.mock("@e2b/code-interpreter", () => ({
	Sandbox: {
		create: sandboxMock.create,
		connect: sandboxMock.connect,
	},
}));

interface Harness {
	ctx: PluginContext;
	provided: Map<string, unknown>;
	hooks: Map<LifecycleEventType, () => Promise<void>>;
	tools: Map<string, ToolHandler>;
	store: Map<string, unknown>;
}

function makeHarness(config: Record<string, unknown> = { apiKey: "test-key" }): Harness {
	const provided = new Map<string, unknown>();
	const hooks = new Map<LifecycleEventType, () => Promise<void>>();
	const tools = new Map<string, ToolHandler>();
	const store = new Map<string, unknown>();
	const ctx = {
		config,
		store: {
			async get<T>(key: string) {
				return (store.get(key) as T | undefined) ?? null;
			},
			async set<T>(key: string, value: T) {
				store.set(key, value);
			},
			async delete(key: string) {
				store.delete(key);
			},
			async list(prefix?: string) {
				return [...store.keys()].filter((key) => !prefix || key.startsWith(prefix));
			},
		},
		inputs: {} as PluginContext["inputs"],
		model: {} as PluginContext["model"],
		log: { debug() {}, info() {}, warn() {}, error() {} },
		require() {
			throw new Error("no required capabilities");
		},
		provide(name: string, implementation: unknown) {
			provided.set(name, implementation);
		},
		hook(event: LifecycleEventType, handler: () => Promise<void>) {
			hooks.set(event, handler);
		},
		tool(def: ToolDefinition, handler: ToolHandler) {
			tools.set(def.name, handler);
		},
		interrupt() {},
	} as unknown as PluginContext;
	return { ctx, provided, hooks, tools, store };
}

function makeSandbox() {
	const commandRun = vi.fn();
	const commandList = vi.fn().mockResolvedValue([{ pid: 42 }]);
	const commandKill = vi.fn().mockResolvedValue(true);
	const filesRead = vi.fn().mockResolvedValue("file contents");
	const filesWrite = vi.fn().mockResolvedValue(undefined);
	const filesList = vi.fn().mockResolvedValue([{ name: "a.txt" }, { name: "b.txt" }]);
	return {
		sandboxId: "sbx_1",
		files: {
			read: filesRead,
			write: filesWrite,
			list: filesList,
		},
		commands: {
			run: commandRun,
			list: commandList,
			kill: commandKill,
		},
		getHost: vi.fn((port: number) => `${port}.sandbox.example`),
		kill: vi.fn().mockResolvedValue(undefined),
	};
}

const toolCtx = { session: { id: "s" }, log: {}, store: {} } as never;

describe("@parel/sandbox-e2b", () => {
	beforeEach(() => {
		sandboxMock.create.mockReset();
		sandboxMock.connect.mockReset();
	});

	it("creates a real sandbox on session:start using config", async () => {
		const sandbox = makeSandbox();
		sandboxMock.create.mockResolvedValue(sandbox);
		const h = makeHarness({ apiKey: "test-key", template: "base", timeout: 60_000 });
		await sandboxE2bPlugin.setup(h.ctx);
		await h.hooks.get(LifecycleEvent.SessionStart)?.();
		expect(sandboxMock.create).toHaveBeenCalledWith("base", {
			timeoutMs: 60_000,
			apiKey: "test-key",
			envs: {},
		});
	});

	it("injects config.env into the sandbox at cold-start", async () => {
		const sandbox = makeSandbox();
		sandboxMock.create.mockResolvedValue(sandbox);
		const h = makeHarness({ apiKey: "test-key", env: { FOO: "bar", TOKEN: "abc" } });
		await sandboxE2bPlugin.setup(h.ctx);
		await h.hooks.get(LifecycleEvent.SessionStart)?.();
		expect(sandboxMock.create).toHaveBeenCalledWith(
			"base",
			expect.objectContaining({ envs: { FOO: "bar", TOKEN: "abc" } }),
		);
	});

	it("keeps legacy bash and file tools", async () => {
		const sandbox = makeSandbox();
		sandbox.commands.run.mockResolvedValue({ exitCode: 0, stdout: "hello\n", stderr: "" });
		sandboxMock.create.mockResolvedValue(sandbox);
		const h = makeHarness();
		await sandboxE2bPlugin.setup(h.ctx);
		await h.hooks.get(LifecycleEvent.SessionStart)?.();

		expect(await h.tools.get("bash")?.({ command: "echo hi" }, toolCtx)).toBe("hello\n");
		expect(sandbox.commands.run).toHaveBeenCalledWith("echo hi");

		await h.tools.get("file_write")?.({ path: "/tmp/x", content: "data" }, toolCtx);
		expect(sandbox.files.write).toHaveBeenCalledWith("/tmp/x", "data");

		expect(await h.tools.get("file_read")?.({ path: "/tmp/x" }, toolCtx)).toBe("file contents");
		expect(sandbox.files.read).toHaveBeenCalledWith("/tmp/x");
	});

	it("injects per-turn invocation context as per-command env on bash", async () => {
		const sandbox = makeSandbox();
		sandbox.commands.run.mockResolvedValue({ exitCode: 0, stdout: "ok\n", stderr: "" });
		sandboxMock.create.mockResolvedValue(sandbox);
		const h = makeHarness();
		await sandboxE2bPlugin.setup(h.ctx);
		await h.hooks.get(LifecycleEvent.SessionStart)?.();

		const ctxWithInvocation = {
			...toolCtx,
			invocationContext: {
				inputId: "in_1",
				turnId: "t_1",
				// non-string value must be JSON-stringified into the env
				context: { PRLL_CHAT_ID: "chat_9", PRLL_SEQ: 7 },
			},
		} as never;
		expect(
			await h.tools.get("bash")?.({ command: "parall messages send hi" }, ctxWithInvocation),
		).toBe("ok\n");
		expect(sandbox.commands.run).toHaveBeenCalledWith("parall messages send hi", {
			envs: { PRLL_CHAT_ID: "chat_9", PRLL_SEQ: "7" },
		});
	});

	it("merges cold-start config.env under per-turn invocation env on bash", async () => {
		const sandbox = makeSandbox();
		sandbox.commands.run.mockResolvedValue({ exitCode: 0, stdout: "ok\n", stderr: "" });
		sandboxMock.create.mockResolvedValue(sandbox);
		const h = makeHarness({
			apiKey: "test-key",
			env: { BASE_TOKEN: "static", PRLL_CHAT_ID: "old" },
		});
		await sandboxE2bPlugin.setup(h.ctx);
		await h.hooks.get(LifecycleEvent.SessionStart)?.();

		const ctxWithInvocation = {
			...toolCtx,
			invocationContext: { inputId: "i", turnId: "t", context: { PRLL_CHAT_ID: "new" } },
		} as never;
		await h.tools.get("bash")?.({ command: "env" }, ctxWithInvocation);
		// Static config.env is preserved; the per-turn value wins on a key conflict.
		expect(sandbox.commands.run).toHaveBeenCalledWith("env", {
			envs: { BASE_TOKEN: "static", PRLL_CHAT_ID: "new" },
		});
	});

	it("treats an explicit null context value as a clear, not a fallback to config.env", async () => {
		const sandbox = makeSandbox();
		sandbox.commands.run.mockResolvedValue({ exitCode: 0, stdout: "ok\n", stderr: "" });
		sandboxMock.create.mockResolvedValue(sandbox);
		const h = makeHarness({ apiKey: "test-key", env: { PRLL_CHAT_ID: "static" } });
		await sandboxE2bPlugin.setup(h.ctx);
		await h.hooks.get(LifecycleEvent.SessionStart)?.();

		const ctxWithNull = {
			...toolCtx,
			invocationContext: { inputId: "i", turnId: "t", context: { PRLL_CHAT_ID: null } },
		} as never;
		await h.tools.get("bash")?.({ command: "env" }, ctxWithNull);
		// Explicit null clears the key (empty string) instead of leaking the static value.
		expect(sandbox.commands.run).toHaveBeenCalledWith("env", { envs: { PRLL_CHAT_ID: "" } });
	});

	it("declares it consumes invocation context in the static manifest", () => {
		expect(sandboxE2bPlugin.consumes?.invocationContext).toBe(true);
	});

	it("provides the standard parel.sandbox capability", async () => {
		const sandbox = makeSandbox();
		sandbox.commands.run.mockResolvedValue({ exitCode: 0, stdout: "hello\n", stderr: "" });
		sandboxMock.create.mockResolvedValue(sandbox);
		const h = makeHarness();
		await sandboxE2bPlugin.setup(h.ctx);
		await h.hooks.get(LifecycleEvent.SessionStart)?.();

		const capability = h.provided.get(PAREL_SANDBOX_CAPABILITY) as SandboxCapability;
		expect(capability.provider).toBe("e2b");
		expect(capability.id).toBe("sbx_1");

		const result = await capability.process?.exec(["echo", "hello world"]);
		expect(sandbox.commands.run).toHaveBeenCalledWith("echo 'hello world'");
		expect(result).toEqual({ stdout: "hello\n", stderr: "", exitCode: 0 });

		const entries = await capability.fs?.listDir("/tmp");
		expect(entries).toEqual([
			{ name: "a.txt", path: undefined, type: "unknown" },
			{ name: "b.txt", path: undefined, type: "unknown" },
		]);
	});

	it("provides process and ports capabilities backed by the E2B sandbox", async () => {
		const sandbox = makeSandbox();
		sandbox.commands.run.mockResolvedValueOnce({
			pid: 42,
			disconnect: vi.fn().mockResolvedValue(undefined),
		});
		sandboxMock.create.mockResolvedValue(sandbox);
		const h = makeHarness();
		await sandboxE2bPlugin.setup(h.ctx);
		await h.hooks.get(LifecycleEvent.SessionStart)?.();

		const processes = h.provided.get("process") as SandboxProcessCapability;
		const ports = h.provided.get("ports") as SandboxPortsCapability;
		expect(processes).toBeDefined();
		expect(ports).toBeDefined();

		const process = await processes.start("pnpm dev", { cwd: "/workspace/repo" });
		expect(process).toMatchObject({
			pid: 42,
			command: "pnpm dev",
			cwd: "/workspace/repo",
			status: "running",
		});
		expect(sandbox.commands.run).toHaveBeenCalledWith(
			expect.stringContaining("sh -lc"),
			expect.objectContaining({ background: true, cwd: "/workspace/repo" }),
		);

		sandbox.commands.run
			.mockResolvedValueOnce({ stdout: "ready\n", stderr: "", exitCode: 0 })
			.mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 0 });
		const tail = await processes.tail(process.id, { maxBytes: 100 });
		expect(tail).toMatchObject({
			stdout: "ready\n",
			stderrPath: process.stderrPath,
		});

		await expect(processes.stop(process.id)).resolves.toMatchObject({ stopped: true });
		expect(sandbox.commands.kill).toHaveBeenCalledWith(42);

		const port = await ports.expose(3000, { protocol: "http" });
		expect(port).toMatchObject({
			port: 3000,
			host: "3000.sandbox.example",
			url: "http://3000.sandbox.example",
		});
		await expect(ports.list()).resolves.toEqual([expect.objectContaining({ port: 3000 })]);
		await expect(ports.revoke(3000)).resolves.toBe(true);
	});

	it("without an API key, no sandbox is created and tools report unavailable", async () => {
		const h = makeHarness({});
		await sandboxE2bPlugin.setup(h.ctx);
		await h.hooks.get(LifecycleEvent.SessionStart)?.();
		expect(sandboxMock.create).not.toHaveBeenCalled();
		await expect(h.tools.get("bash")?.({ command: "echo hi" }, toolCtx)).rejects.toThrow(
			"not available",
		);
	});

	it("destroys the sandbox on session:end", async () => {
		const sandbox = makeSandbox();
		sandboxMock.create.mockResolvedValue(sandbox);
		const h = makeHarness();
		await sandboxE2bPlugin.setup(h.ctx);
		await h.hooks.get(LifecycleEvent.SessionStart)?.();
		await h.hooks.get(LifecycleEvent.SessionEnd)?.();
		expect(sandbox.kill).toHaveBeenCalledOnce();
	});

	it("declares its apiKey secret requirement from the static manifest", () => {
		expect(sandboxE2bPlugin.requires?.secrets?.apiKey).toEqual({
			description: expect.stringContaining("E2B API key"),
			required: true,
		});
	});
});
