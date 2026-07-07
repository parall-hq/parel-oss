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
	kill: vi.fn(),
}));

const FakeCommandExitError = vi.hoisted(
	() =>
		class FakeCommandExitError extends Error {
			exitCode: number;
			stdout: string;
			stderr: string;
			constructor(result: { exitCode: number; stdout: string; stderr: string }) {
				super(`exit status ${result.exitCode}`);
				this.exitCode = result.exitCode;
				this.stdout = result.stdout;
				this.stderr = result.stderr;
			}
		},
);

vi.mock("@e2b/code-interpreter", () => ({
	Sandbox: {
		create: sandboxMock.create,
		connect: sandboxMock.connect,
		kill: sandboxMock.kill,
	},
	CommandExitError: FakeCommandExitError,
}));

interface Harness {
	ctx: PluginContext;
	provided: Map<string, unknown>;
	hooks: Map<LifecycleEventType, () => Promise<void>>;
	tools: Map<string, ToolHandler>;
	store: Map<string, unknown>;
}

// In-memory InstanceStore with real cas() semantics. One of these shared by two
// harnesses simulates two sessions of the same agent instance.
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
		async list(prefix?: string) {
			return [...rows.keys()].filter((key) => !prefix || key.startsWith(prefix));
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

function makeHarness(
	config: Record<string, unknown> = { apiKey: "test-key" },
	instanceStore?: ReturnType<typeof makeInstanceStore>,
): Harness {
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
		instanceStore,
		instance: instanceStore ? { key: "main", ephemeral: false } : undefined,
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
		sandboxMock.kill.mockReset();
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

	it("without an API key, session start and tools fail loudly with the real reason", async () => {
		const h = makeHarness({});
		await sandboxE2bPlugin.setup(h.ctx);
		await expect(h.hooks.get(LifecycleEvent.SessionStart)?.()).rejects.toThrow(
			"E2B API key not provided",
		);
		await expect(h.tools.get("bash")?.({ command: "echo hi" }, toolCtx)).rejects.toThrow(
			"E2B API key not provided",
		);
		expect(sandboxMock.create).not.toHaveBeenCalled();
	});

	it("destroys the sandbox on session:end", async () => {
		const sandbox = makeSandbox();
		sandboxMock.create.mockResolvedValue(sandbox);
		sandboxMock.kill.mockResolvedValue(true);
		const h = makeHarness();
		await sandboxE2bPlugin.setup(h.ctx);
		await h.hooks.get(LifecycleEvent.SessionStart)?.();
		await h.hooks.get(LifecycleEvent.SessionEnd)?.();
		expect(sandboxMock.kill).toHaveBeenCalledWith("sbx_1", { apiKey: "test-key" });
		expect(h.store.has("e2b_sandbox_id")).toBe(false);
	});

	it("session:end kills the stored sandbox even without a live handle", async () => {
		sandboxMock.kill.mockResolvedValue(true);
		const h = makeHarness();
		await sandboxE2bPlugin.setup(h.ctx);
		h.store.set("e2b_sandbox_id", "sbx_orphan");
		await h.hooks.get(LifecycleEvent.SessionEnd)?.();
		expect(sandboxMock.kill).toHaveBeenCalledWith("sbx_orphan", { apiKey: "test-key" });
		expect(h.store.has("e2b_sandbox_id")).toBe(false);
	});

	it("declares its apiKey secret requirement from the static manifest", () => {
		expect(sandboxE2bPlugin.requires?.secrets?.apiKey).toEqual({
			description: expect.stringContaining("E2B API key"),
			required: true,
		});
	});

	describe("non-zero exit (e2b SDK 2.x throws CommandExitError)", () => {
		it("bash tool returns the failing command's output instead of crashing the tool", async () => {
			const sandbox = makeSandbox();
			sandbox.commands.run.mockRejectedValue(
				new FakeCommandExitError({
					exitCode: 1,
					stdout: "",
					stderr: "cat: /tmp/x: No such file or directory",
				}),
			);
			sandboxMock.create.mockResolvedValue(sandbox);
			const h = makeHarness();
			await sandboxE2bPlugin.setup(h.ctx);
			await h.hooks.get(LifecycleEvent.SessionStart)?.();

			expect(await h.tools.get("bash")?.({ command: "cat /tmp/x" }, toolCtx)).toBe(
				"Exit code: 1\ncat: /tmp/x: No such file or directory",
			);
		});

		it("sandbox capability exec surfaces exitCode/stderr as a result", async () => {
			const sandbox = makeSandbox();
			sandbox.commands.run.mockRejectedValue(
				new FakeCommandExitError({ exitCode: 2, stdout: "partial", stderr: "boom" }),
			);
			sandboxMock.create.mockResolvedValue(sandbox);
			const h = makeHarness();
			await sandboxE2bPlugin.setup(h.ctx);
			await h.hooks.get(LifecycleEvent.SessionStart)?.();

			const capability = h.provided.get(PAREL_SANDBOX_CAPABILITY) as SandboxCapability;
			const result = await capability.process?.exec(["cat", "/tmp/x"]);
			expect(result).toEqual({ stdout: "partial", stderr: "boom", exitCode: 2 });
		});

		it("non-exit errors (e.g. disconnect) still throw", async () => {
			const sandbox = makeSandbox();
			sandbox.commands.run.mockRejectedValue(new Error("sandbox disconnected"));
			sandboxMock.create.mockResolvedValue(sandbox);
			const h = makeHarness();
			await sandboxE2bPlugin.setup(h.ctx);
			await h.hooks.get(LifecycleEvent.SessionStart)?.();

			await expect(h.tools.get("bash")?.({ command: "true" }, toolCtx)).rejects.toThrow(
				"sandbox disconnected",
			);
		});
	});

	describe("persistence", () => {
		it("persistence: true requests pause-on-timeout with a filesystem-only snapshot", async () => {
			const sandbox = makeSandbox();
			sandboxMock.create.mockResolvedValue(sandbox);
			const h = makeHarness({ apiKey: "test-key", persistence: true });
			await sandboxE2bPlugin.setup(h.ctx);
			await h.hooks.get(LifecycleEvent.SessionStart)?.();

			expect(sandboxMock.create).toHaveBeenCalledWith("base", {
				timeoutMs: 300_000,
				apiKey: "test-key",
				envs: {},
				lifecycle: { onTimeout: { action: "pause", keepMemory: false } },
			});
		});

		it("keepMemory: true also snapshots memory", async () => {
			const sandbox = makeSandbox();
			sandboxMock.create.mockResolvedValue(sandbox);
			const h = makeHarness({ apiKey: "test-key", persistence: true, keepMemory: true });
			await sandboxE2bPlugin.setup(h.ctx);
			await h.hooks.get(LifecycleEvent.SessionStart)?.();

			expect(sandboxMock.create).toHaveBeenCalledWith(
				"base",
				expect.objectContaining({
					lifecycle: { onTimeout: { action: "pause", keepMemory: true } },
				}),
			);
		});

		it("default config still creates without a lifecycle option (kill-on-timeout)", async () => {
			const sandbox = makeSandbox();
			sandboxMock.create.mockResolvedValue(sandbox);
			const h = makeHarness();
			await sandboxE2bPlugin.setup(h.ctx);
			await h.hooks.get(LifecycleEvent.SessionStart)?.();

			const opts = sandboxMock.create.mock.calls[0][1] as Record<string, unknown>;
			expect("lifecycle" in opts).toBe(false);
		});

		it("session resume reconnects the stored sandbox id (paused sandboxes auto-resume)", async () => {
			const sandbox = makeSandbox();
			sandboxMock.connect.mockResolvedValue(sandbox);
			const h = makeHarness({ apiKey: "test-key", persistence: true });
			await sandboxE2bPlugin.setup(h.ctx);
			h.store.set("e2b_sandbox_id", "sbx_paused");

			await h.hooks.get(LifecycleEvent.SessionResume)?.();

			expect(sandboxMock.connect).toHaveBeenCalledWith("sbx_paused", { apiKey: "test-key" });
			expect(sandboxMock.create).not.toHaveBeenCalled();
		});

		it("resume falls back to a fresh sandbox when the snapshot is gone", async () => {
			const sandbox = makeSandbox();
			sandboxMock.connect.mockRejectedValue(new Error("sandbox not found"));
			sandboxMock.create.mockResolvedValue(sandbox);
			sandboxMock.kill.mockResolvedValue(true);
			const h = makeHarness({ apiKey: "test-key", persistence: true });
			await sandboxE2bPlugin.setup(h.ctx);
			h.store.set("e2b_sandbox_id", "sbx_gone");

			await h.hooks.get(LifecycleEvent.SessionResume)?.();

			// One retry before giving up on the stored sandbox.
			expect(sandboxMock.connect).toHaveBeenCalledTimes(2);
			expect(sandboxMock.create).toHaveBeenCalledTimes(1);
			// The unreachable sandbox is reaped so its paused snapshot can't leak.
			expect(sandboxMock.kill).toHaveBeenCalledWith("sbx_gone", { apiKey: "test-key" });
			expect(h.store.get("e2b_sandbox_id")).toBe("sbx_1");
		});

		it("resume retries a transient reconnect failure before swapping the sandbox", async () => {
			const sandbox = makeSandbox();
			sandboxMock.connect
				.mockRejectedValueOnce(new Error("network blip"))
				.mockResolvedValueOnce(sandbox);
			const h = makeHarness({ apiKey: "test-key", persistence: true });
			await sandboxE2bPlugin.setup(h.ctx);
			h.store.set("e2b_sandbox_id", "sbx_flaky");

			await h.hooks.get(LifecycleEvent.SessionResume)?.();

			expect(sandboxMock.connect).toHaveBeenCalledTimes(2);
			// The filesystem was NOT reset: no fresh sandbox, no kill.
			expect(sandboxMock.create).not.toHaveBeenCalled();
			expect(sandboxMock.kill).not.toHaveBeenCalled();
		});

		it("does not kill the stored sandbox when its replacement fails to create", async () => {
			sandboxMock.connect.mockRejectedValue(new Error("region outage"));
			sandboxMock.create.mockRejectedValue(new Error("quota exceeded"));
			const h = makeHarness({ apiKey: "test-key", persistence: true });
			await sandboxE2bPlugin.setup(h.ctx);
			h.store.set("e2b_sandbox_id", "sbx_saved");

			await expect(h.hooks.get(LifecycleEvent.SessionResume)?.()).rejects.toThrow(
				"Failed to create E2B sandbox: quota exceeded",
			);
			// The old snapshot must survive: kill only after a replacement exists,
			// so a later attempt can still reconnect to the user's files.
			expect(sandboxMock.kill).not.toHaveBeenCalled();
			expect(h.store.get("e2b_sandbox_id")).toBe("sbx_saved");

			// E2B recovers: the next tool call reconnects and the files are intact.
			const sandbox = makeSandbox();
			sandbox.commands.run.mockResolvedValue({ exitCode: 0, stdout: "intact\n", stderr: "" });
			sandboxMock.connect.mockReset();
			sandboxMock.connect.mockResolvedValue(sandbox);
			expect(await h.tools.get("bash")?.({ command: "ls" }, toolCtx)).toBe("intact\n");
			expect(sandboxMock.connect).toHaveBeenCalledWith("sbx_saved", { apiKey: "test-key" });
		});
	});

	// The lifecycle hooks are the warm path; these cover the fallback when they
	// were skipped or misfired (e.g. a dispatch short-circuit) and the sandbox
	// field is still null when the first tool of the turn runs.
	describe("self-healing on the tool call path", () => {
		it("hooks never ran: the first tool call reconnects the stored sandbox", async () => {
			const sandbox = makeSandbox();
			sandbox.commands.run.mockResolvedValue({ exitCode: 0, stdout: "healed\n", stderr: "" });
			sandboxMock.connect.mockResolvedValue(sandbox);
			const h = makeHarness({ apiKey: "test-key", persistence: true });
			await sandboxE2bPlugin.setup(h.ctx);
			h.store.set("e2b_sandbox_id", "sbx_paused");

			expect(await h.tools.get("bash")?.({ command: "echo hi" }, toolCtx)).toBe("healed\n");
			expect(sandboxMock.connect).toHaveBeenCalledWith("sbx_paused", { apiKey: "test-key" });
			expect(sandboxMock.create).not.toHaveBeenCalled();
		});

		it("hooks never ran and the stored sandbox is gone: the tool call swaps in a fresh one and reaps the old", async () => {
			const sandbox = makeSandbox();
			sandboxMock.connect.mockRejectedValue(new Error("sandbox not found"));
			sandboxMock.create.mockResolvedValue(sandbox);
			sandboxMock.kill.mockResolvedValue(true);
			const h = makeHarness({ apiKey: "test-key", persistence: true });
			await sandboxE2bPlugin.setup(h.ctx);
			h.store.set("e2b_sandbox_id", "sbx_dead");

			await h.tools.get("file_write")?.({ path: "/tmp/x", content: "data" }, toolCtx);

			expect(sandboxMock.kill).toHaveBeenCalledWith("sbx_dead", { apiKey: "test-key" });
			expect(h.store.get("e2b_sandbox_id")).toBe("sbx_1");
			expect(sandbox.files.write).toHaveBeenCalledWith("/tmp/x", "data");
		});

		it("hooks never ran and nothing is stored: a capability call creates the sandbox", async () => {
			const sandbox = makeSandbox();
			sandbox.commands.run.mockResolvedValue({ exitCode: 0, stdout: "made\n", stderr: "" });
			sandboxMock.create.mockResolvedValue(sandbox);
			const h = makeHarness();
			await sandboxE2bPlugin.setup(h.ctx);

			const capability = h.provided.get(PAREL_SANDBOX_CAPABILITY) as SandboxCapability;
			const result = await capability.process?.shell("echo hi");
			expect(result).toMatchObject({ stdout: "made\n", exitCode: 0 });
			expect(sandboxMock.create).toHaveBeenCalledTimes(1);
			expect(sandboxMock.connect).not.toHaveBeenCalled();
		});

		it("concurrent tool calls share one in-flight recovery (single-flight)", async () => {
			const sandbox = makeSandbox();
			sandbox.commands.run.mockResolvedValue({ exitCode: 0, stdout: "ok\n", stderr: "" });
			let release: (value: unknown) => void = () => {};
			sandboxMock.create.mockImplementation(
				() =>
					new Promise((resolve) => {
						release = resolve;
					}),
			);
			const h = makeHarness();
			await sandboxE2bPlugin.setup(h.ctx);

			const first = h.tools.get("bash")?.({ command: "echo one" }, toolCtx);
			const second = h.tools.get("file_read")?.({ path: "/tmp/x" }, toolCtx);
			// Let both calls reach the recovery path while creation is still pending.
			await new Promise((resolve) => setTimeout(resolve, 0));
			release(sandbox);

			expect(await first).toBe("ok\n");
			expect(await second).toBe("file contents");
			expect(sandboxMock.create).toHaveBeenCalledTimes(1);
		});

		it("a failed recovery is not cached: the next tool call retries and the error names the cause", async () => {
			const sandbox = makeSandbox();
			sandbox.commands.run.mockResolvedValue({ exitCode: 0, stdout: "ok\n", stderr: "" });
			sandboxMock.create.mockRejectedValueOnce(new Error("E2B 503")).mockResolvedValueOnce(sandbox);
			const h = makeHarness();
			await sandboxE2bPlugin.setup(h.ctx);

			await expect(h.tools.get("bash")?.({ command: "echo hi" }, toolCtx)).rejects.toThrow(
				"Failed to create E2B sandbox: E2B 503",
			);
			expect(await h.tools.get("bash")?.({ command: "echo hi" }, toolCtx)).toBe("ok\n");
			expect(sandboxMock.create).toHaveBeenCalledTimes(2);
		});

		it("a failed resume clears the stale pre-suspend handle so tools can self-heal later", async () => {
			const preSuspend = makeSandbox();
			sandboxMock.create.mockResolvedValueOnce(preSuspend);
			const h = makeHarness({ apiKey: "test-key", persistence: true });
			await sandboxE2bPlugin.setup(h.ctx);
			await h.hooks.get(LifecycleEvent.SessionStart)?.();

			// Resume fails entirely: reconnect and replacement creation both down.
			sandboxMock.connect.mockRejectedValue(new Error("region outage"));
			sandboxMock.create.mockRejectedValueOnce(new Error("quota exceeded"));
			await expect(h.hooks.get(LifecycleEvent.SessionResume)?.()).rejects.toThrow(
				"Failed to create E2B sandbox: quota exceeded",
			);

			// E2B recovers: the next tool call must not keep returning the stale
			// pre-suspend handle — it re-runs the stored-id recovery instead.
			const recovered = makeSandbox();
			recovered.commands.run.mockResolvedValue({ exitCode: 0, stdout: "back\n", stderr: "" });
			sandboxMock.connect.mockReset();
			sandboxMock.connect.mockResolvedValue(recovered);
			expect(await h.tools.get("bash")?.({ command: "ls" }, toolCtx)).toBe("back\n");
			expect(sandboxMock.connect).toHaveBeenCalledWith("sbx_1", { apiKey: "test-key" });
		});

		it("session end during an in-flight recovery settles it before teardown resolves", async () => {
			const sandbox = makeSandbox();
			let release: (value: unknown) => void = () => {};
			sandboxMock.create.mockImplementation(
				() =>
					new Promise((resolve) => {
						release = resolve;
					}),
			);
			sandboxMock.kill.mockResolvedValue(true);
			const h = makeHarness();
			await sandboxE2bPlugin.setup(h.ctx);

			const call = h.tools.get("bash")?.({ command: "echo hi" }, toolCtx);
			// Let the recovery reach the pending creation, then tear the session down.
			await new Promise((resolve) => setTimeout(resolve, 0));
			const ending = h.hooks.get(LifecycleEvent.SessionEnd)?.();
			// Teardown must wait for the pending recovery instead of racing it.
			await new Promise((resolve) => setTimeout(resolve, 0));
			release(sandbox);
			await ending;

			// By the time teardown resolved, the late sandbox was already reaped,
			// nothing was published, and no stored id survived.
			expect(sandboxMock.kill).toHaveBeenCalledWith("sbx_1", { apiKey: "test-key" });
			expect(h.store.has("e2b_sandbox_id")).toBe(false);
			await expect(call).rejects.toThrow("torn down during recovery");
			const capability = h.provided.get(PAREL_SANDBOX_CAPABILITY) as SandboxCapability;
			expect(await capability.lifecycle?.isRunning()).toBe(false);
		});
	});

	describe("instance mode (ctx.instanceStore present)", () => {
		it("adopts the instance's existing sandbox on session:start instead of creating", async () => {
			const istore = makeInstanceStore();
			await istore.set("e2b_sandbox_id", "sbx_shared");
			const shared = makeSandbox();
			shared.sandboxId = "sbx_shared";
			sandboxMock.connect.mockResolvedValue(shared);

			const h = makeHarness({ apiKey: "test-key" }, istore);
			await sandboxE2bPlugin.setup(h.ctx);
			await h.hooks.get(LifecycleEvent.SessionStart)?.();

			expect(sandboxMock.connect).toHaveBeenCalledWith("sbx_shared", { apiKey: "test-key" });
			expect(sandboxMock.create).not.toHaveBeenCalled();
		});

		it("cold-start race: exactly one sibling wins, the loser reaps its orphan and adopts", async () => {
			const istore = makeInstanceStore();
			const sbA = makeSandbox();
			sbA.sandboxId = "sbx_a";
			const sbB = makeSandbox();
			sbB.sandboxId = "sbx_b";
			sandboxMock.create.mockResolvedValueOnce(sbA).mockResolvedValueOnce(sbB);
			// The loser re-reads and connects to the winner's sandbox.
			sandboxMock.connect.mockImplementation(async (id: string) => (id === "sbx_a" ? sbA : sbB));

			const hA = makeHarness({ apiKey: "test-key" }, istore);
			const hB = makeHarness({ apiKey: "test-key" }, istore);
			await sandboxE2bPlugin.setup(hA.ctx);
			await sandboxE2bPlugin.setup(hB.ctx);
			await Promise.all([
				hA.hooks.get(LifecycleEvent.SessionStart)?.(),
				hB.hooks.get(LifecycleEvent.SessionStart)?.(),
			]);

			// One authoritative handle; the losing creation was killed.
			const winner = (await istore.get<string>("e2b_sandbox_id"))?.value;
			expect(["sbx_a", "sbx_b"]).toContain(winner);
			const loser = winner === "sbx_a" ? "sbx_b" : "sbx_a";
			expect(sandboxMock.kill).toHaveBeenCalledWith(loser, { apiKey: "test-key" });
			expect(sandboxMock.kill).not.toHaveBeenCalledWith(winner, { apiKey: "test-key" });
		});

		it("session:end releases the local handle but never kills the shared sandbox", async () => {
			const istore = makeInstanceStore();
			await istore.set("e2b_sandbox_id", "sbx_shared");
			const shared = makeSandbox();
			shared.sandboxId = "sbx_shared";
			sandboxMock.connect.mockResolvedValue(shared);

			const h = makeHarness({ apiKey: "test-key" }, istore);
			await sandboxE2bPlugin.setup(h.ctx);
			await h.hooks.get(LifecycleEvent.SessionStart)?.();
			await h.hooks.get(LifecycleEvent.SessionEnd)?.();

			expect(sandboxMock.kill).not.toHaveBeenCalled();
			expect((await istore.get<string>("e2b_sandbox_id"))?.value).toBe("sbx_shared");
			const capability = h.provided.get(PAREL_SANDBOX_CAPABILITY) as SandboxCapability;
			expect(await capability.lifecycle?.isRunning()).toBe(false);
		});

		it("migrates a live legacy per-session sandbox into the instance store", async () => {
			const istore = makeInstanceStore();
			const legacy = makeSandbox();
			legacy.sandboxId = "sbx_legacy";
			sandboxMock.connect.mockResolvedValue(legacy);

			const h = makeHarness({ apiKey: "test-key" }, istore);
			h.store.set("e2b_sandbox_id", "sbx_legacy");
			await sandboxE2bPlugin.setup(h.ctx);
			await h.hooks.get(LifecycleEvent.SessionStart)?.();

			expect((await istore.get<string>("e2b_sandbox_id"))?.value).toBe("sbx_legacy");
			expect(h.store.has("e2b_sandbox_id")).toBe(false);
			expect(sandboxMock.create).not.toHaveBeenCalled();
			expect(sandboxMock.kill).not.toHaveBeenCalled();
		});

		it("migrates legacy process/port records along with a promoted sandbox", async () => {
			const istore = makeInstanceStore();
			const legacy = makeSandbox();
			legacy.sandboxId = "sbx_legacy";
			sandboxMock.connect.mockResolvedValue(legacy);

			const h = makeHarness({ apiKey: "test-key" }, istore);
			h.store.set("e2b_sandbox_id", "sbx_legacy");
			h.store.set("e2b_process:p1", { id: "p1", pid: 9, status: "running" });
			h.store.set("e2b_port:3000", { id: "3000", port: 3000 });
			await sandboxE2bPlugin.setup(h.ctx);
			await h.hooks.get(LifecycleEvent.SessionStart)?.();

			// The sandbox's running processes/ports must stay visible after the
			// upgrade — their records follow the sandbox into the instance store.
			expect(await istore.list("e2b_process:")).toEqual(["e2b_process:p1"]);
			expect(await istore.list("e2b_port:")).toEqual(["e2b_port:3000"]);
			expect(h.store.size).toBe(0);
		});

		it("drops ghost process/port records when the legacy sandbox is reaped", async () => {
			const istore = makeInstanceStore();
			await istore.set("e2b_sandbox_id", "sbx_shared");
			const shared = makeSandbox();
			shared.sandboxId = "sbx_shared";
			const legacy = makeSandbox();
			legacy.sandboxId = "sbx_legacy";
			sandboxMock.connect.mockImplementation(async (id: string) =>
				id === "sbx_shared" ? shared : legacy,
			);

			const h = makeHarness({ apiKey: "test-key" }, istore);
			h.store.set("e2b_sandbox_id", "sbx_legacy");
			h.store.set("e2b_process:p1", { id: "p1", pid: 9, status: "running" });
			await sandboxE2bPlugin.setup(h.ctx);
			await h.hooks.get(LifecycleEvent.SessionStart)?.();

			// The legacy sandbox was killed — its process records are ghosts and
			// must not pollute the shared instance's tables.
			expect(await istore.list("e2b_process:")).toEqual([]);
			expect(h.store.size).toBe(0);
		});

		it("reaps its legacy sandbox when a sibling's is already authoritative", async () => {
			const istore = makeInstanceStore();
			await istore.set("e2b_sandbox_id", "sbx_shared");
			const shared = makeSandbox();
			shared.sandboxId = "sbx_shared";
			const legacy = makeSandbox();
			legacy.sandboxId = "sbx_legacy";
			sandboxMock.connect.mockImplementation(async (id: string) =>
				id === "sbx_shared" ? shared : legacy,
			);

			const h = makeHarness({ apiKey: "test-key" }, istore);
			h.store.set("e2b_sandbox_id", "sbx_legacy");
			await sandboxE2bPlugin.setup(h.ctx);
			await h.hooks.get(LifecycleEvent.SessionStart)?.();

			// The shared sandbox wins; the legacy one is an orphan and must be
			// killed (a paused snapshot would otherwise be billed forever).
			expect(sandboxMock.kill).toHaveBeenCalledWith("sbx_legacy", { apiKey: "test-key" });
			expect((await istore.get<string>("e2b_sandbox_id"))?.value).toBe("sbx_shared");
			expect(h.store.has("e2b_sandbox_id")).toBe(false);
		});

		it("replaces an unreachable shared sandbox via versioned cas", async () => {
			const istore = makeInstanceStore();
			await istore.set("e2b_sandbox_id", "sbx_dead");
			sandboxMock.connect.mockResolvedValue(null);
			sandboxMock.connect.mockRejectedValue(new Error("gone"));
			const fresh = makeSandbox();
			fresh.sandboxId = "sbx_fresh";
			sandboxMock.create.mockResolvedValue(fresh);

			const h = makeHarness({ apiKey: "test-key" }, istore);
			await sandboxE2bPlugin.setup(h.ctx);
			await h.hooks.get(LifecycleEvent.SessionStart)?.();

			expect((await istore.get<string>("e2b_sandbox_id"))?.value).toBe("sbx_fresh");
			expect(sandboxMock.kill).toHaveBeenCalledWith("sbx_dead", { apiKey: "test-key" });
		});

		it("explicit lifecycle.stop kills the instance sandbox and clears the handle", async () => {
			const istore = makeInstanceStore();
			await istore.set("e2b_sandbox_id", "sbx_shared");
			const shared = makeSandbox();
			shared.sandboxId = "sbx_shared";
			sandboxMock.connect.mockResolvedValue(shared);
			sandboxMock.kill.mockResolvedValue(true);

			const h = makeHarness({ apiKey: "test-key" }, istore);
			await sandboxE2bPlugin.setup(h.ctx);
			await h.hooks.get(LifecycleEvent.SessionStart)?.();
			const capability = h.provided.get(PAREL_SANDBOX_CAPABILITY) as SandboxCapability;
			await capability.lifecycle?.stop();

			expect(sandboxMock.kill).toHaveBeenCalledWith("sbx_shared", { apiKey: "test-key" });
			expect(await istore.get("e2b_sandbox_id")).toBeNull();
		});

		it("drops a cached handle when a sibling replaced the shared sandbox", async () => {
			const istore = makeInstanceStore();
			await istore.set("e2b_sandbox_id", "sbx_old");
			const oldSb = makeSandbox();
			oldSb.sandboxId = "sbx_old";
			const newSb = makeSandbox();
			newSb.sandboxId = "sbx_new";
			newSb.files.read.mockResolvedValue("from new sandbox");
			sandboxMock.connect.mockImplementation(async (id: string) =>
				id === "sbx_old" ? oldSb : newSb,
			);

			const h = makeHarness({ apiKey: "test-key" }, istore);
			await sandboxE2bPlugin.setup(h.ctx);
			await h.hooks.get(LifecycleEvent.SessionStart)?.(); // caches sbx_old

			// A sibling replaces the shared sandbox behind our back.
			await istore.set("e2b_sandbox_id", "sbx_new");

			// The next tool call must notice the stale handle and re-acquire.
			expect(await h.tools.get("file_read")?.({ path: "/x" }, toolCtx)).toBe("from new sandbox");
			expect(sandboxMock.connect).toHaveBeenCalledWith("sbx_new", { apiKey: "test-key" });
		});

		it("concurrent tool calls survive a sibling's replacement without TypeError", async () => {
			const istore = makeInstanceStore();
			await istore.set("e2b_sandbox_id", "sbx_old");
			const oldSb = makeSandbox();
			oldSb.sandboxId = "sbx_old";
			const newSb = makeSandbox();
			newSb.sandboxId = "sbx_new";
			newSb.files.read.mockResolvedValue("from new sandbox");
			sandboxMock.connect.mockImplementation(async (id: string) =>
				id === "sbx_old" ? oldSb : newSb,
			);

			const h = makeHarness({ apiKey: "test-key" }, istore);
			await sandboxE2bPlugin.setup(h.ctx);
			await h.hooks.get(LifecycleEvent.SessionStart)?.(); // caches sbx_old
			await istore.set("e2b_sandbox_id", "sbx_new"); // sibling swaps

			// Both calls enter the staleness check together; the first nulls the
			// shared slot — the second must not crash on it (captured local).
			const [a, b] = await Promise.all([
				h.tools.get("file_read")?.({ path: "/a" }, toolCtx),
				h.tools.get("file_read")?.({ path: "/b" }, toolCtx),
			]);
			expect(a).toBe("from new sandbox");
			expect(b).toBe("from new sandbox");
		});

		it("does not adopt a sandbox superseded during the reconnect window", async () => {
			const istore = makeInstanceStore();
			await istore.set("e2b_sandbox_id", "sbx_old");
			const oldSb = makeSandbox();
			oldSb.sandboxId = "sbx_old";
			const newSb = makeSandbox();
			newSb.sandboxId = "sbx_new";
			// While we reconnect to sbx_old, a sibling swaps the handle to
			// sbx_new — the old sandbox still answers connect() successfully.
			sandboxMock.connect.mockImplementation(async (id: string) => {
				if (id === "sbx_old") {
					await istore.set("e2b_sandbox_id", "sbx_new");
					return oldSb;
				}
				return newSb;
			});

			const h = makeHarness({ apiKey: "test-key" }, istore);
			await sandboxE2bPlugin.setup(h.ctx);
			await h.hooks.get(LifecycleEvent.SessionStart)?.();

			// The acquire must have retried and landed on the authoritative one.
			const capability = h.provided.get(PAREL_SANDBOX_CAPABILITY) as SandboxCapability;
			expect(capability.id).toBe("sbx_new");
		});

		it("skips the kill when lifecycle.stop loses the retire race", async () => {
			const istore = makeInstanceStore();
			await istore.set("e2b_sandbox_id", "sbx_shared");
			const shared = makeSandbox();
			shared.sandboxId = "sbx_shared";
			sandboxMock.connect.mockResolvedValue(shared);

			// Sabotage casDelete to simulate a sibling swapping mid-stop.
			istore.casDelete = async () => false;

			const h = makeHarness({ apiKey: "test-key" }, istore);
			await sandboxE2bPlugin.setup(h.ctx);
			await h.hooks.get(LifecycleEvent.SessionStart)?.();
			const capability = h.provided.get(PAREL_SANDBOX_CAPABILITY) as SandboxCapability;
			await capability.lifecycle?.stop();

			expect(sandboxMock.kill).not.toHaveBeenCalled();
			expect((await istore.get<string>("e2b_sandbox_id"))?.value).toBe("sbx_shared");
		});

		it("destroys the sandbox on session:end for an ephemeral instance", async () => {
			const istore = makeInstanceStore();
			const sandbox = makeSandbox();
			sandbox.sandboxId = "sbx_eph";
			sandboxMock.create.mockResolvedValue(sandbox);
			sandboxMock.kill.mockResolvedValue(true);

			const h = makeHarness({ apiKey: "test-key" }, istore);
			(h.ctx as { instance?: { key: string | null; ephemeral: boolean } }).instance = {
				key: null,
				ephemeral: true,
			};
			await sandboxE2bPlugin.setup(h.ctx);
			await h.hooks.get(LifecycleEvent.SessionStart)?.();
			await h.hooks.get(LifecycleEvent.SessionEnd)?.();

			// Ephemeral instance dies with the session: nothing could ever stop
			// this sandbox later, so SessionEnd must kill it.
			expect(sandboxMock.kill).toHaveBeenCalledWith("sbx_eph", { apiKey: "test-key" });
		});

		it("stores process records in the instance store so siblings see them", async () => {
			const istore = makeInstanceStore();
			const sandbox = makeSandbox();
			sandbox.sandboxId = "sbx_shared";
			sandboxMock.create.mockResolvedValue(sandbox);
			sandbox.commands.run.mockResolvedValue({ pid: 7, disconnect: async () => {} });

			const h = makeHarness({ apiKey: "test-key" }, istore);
			await sandboxE2bPlugin.setup(h.ctx);
			const processes = h.provided.get("process") as SandboxProcessCapability;
			await processes.start("sleep 1000");

			const keys = await istore.list("e2b_process:");
			expect(keys).toHaveLength(1);
			expect(h.store.size).toBe(0);
		});
	});
});
