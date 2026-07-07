import {
	PAREL_SANDBOX_CAPABILITY,
	type SandboxCapability,
	type SandboxProcessView,
} from "@parel/capability-sandbox";
import type { HookHandler, LifecycleEvent, PluginContext } from "@parel/plugin-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";

const vercel = vi.hoisted(() => {
	const stdout = vi.fn();
	const stderr = vi.fn();
	const wait = vi.fn();
	const kill = vi.fn();
	const command = { cmdId: "cmd-1", exitCode: 0, stdout, stderr, wait, kill };
	const detached = { cmdId: "cmd-2", exitCode: null, stdout, stderr, wait, kill };
	const readFile = vi.fn();
	const writeFile = vi.fn();
	const appendFile = vi.fn();
	const readdir = vi.fn();
	const stat = vi.fn();
	const exists = vi.fn();
	const mkdir = vi.fn();
	const rm = vi.fn();
	const rename = vi.fn();
	const runCommand = vi.fn();
	const domain = vi.fn();
	const stop = vi.fn();
	const destroy = vi.fn();
	const extendTimeout = vi.fn();
	const sandbox = {
		name: "parel-agent",
		status: "running",
		fs: { readFile, writeFile, appendFile, readdir, stat, exists, mkdir, rm, rename },
		runCommand,
		domain,
		stop,
		delete: destroy,
		extendTimeout,
	};
	return {
		create: vi.fn(),
		getOrCreate: vi.fn(),
		get: vi.fn(),
		command,
		detached,
		stdout,
		stderr,
		wait,
		kill,
		readFile,
		writeFile,
		appendFile,
		readdir,
		stat,
		exists,
		mkdir,
		rm,
		rename,
		runCommand,
		domain,
		stop,
		destroy,
		extendTimeout,
		sandbox,
	};
});

vi.mock("@vercel/sandbox", () => ({
	Sandbox: {
		create: vercel.create,
		getOrCreate: vercel.getOrCreate,
		get: vercel.get,
	},
}));

import sandboxPlugin from "./index.js";

function makeStore() {
	const map = new Map<string, unknown>();
	return {
		async get<T>(k: string) {
			return (map.has(k) ? (map.get(k) as T) : null) as T | null;
		},
		async set<T>(k: string, v: T) {
			map.set(k, v);
		},
		async delete(k: string) {
			map.delete(k);
		},
		async list(prefix?: string) {
			return [...map.keys()].filter((k) => !prefix || k.startsWith(prefix));
		},
		map,
	};
}

// In-memory InstanceStore with real cas()/casDelete() semantics. One of these
// shared by two harnesses simulates two sessions of the same agent instance.
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
	config: Record<string, unknown>,
	instanceStore?: ReturnType<typeof makeInstanceStore>,
) {
	const hooks = new Map<string, HookHandler<LifecycleEvent>>();
	const provided = new Map<string, unknown>();
	const store = makeStore();
	const ctx = {
		config,
		store,
		instanceStore,
		instance: instanceStore ? { key: "main", ephemeral: false } : undefined,
		inputs: { drain: () => [], peek: () => [], push() {} },
		log: { debug() {}, info() {}, warn() {}, error() {} },
		hook(event: string, handler: HookHandler<LifecycleEvent>) {
			hooks.set(event, handler);
		},
		tool() {},
		provide(name: string, impl: unknown) {
			provided.set(name, impl);
		},
		require() {
			throw new Error("not provided");
		},
		interrupt() {},
	} as unknown as PluginContext;
	return { ctx, hooks, provided, store };
}

// A distinct mock sandbox with its own lifecycle mocks — instance-mode tests
// need to tell a winner's handle from a loser's orphan. The default runCommand
// returns a finished command whose stdout is `pid`, so the process view can
// parse a background pid when starting a process.
function makeSb(name: string, pid = "4242") {
	const command = {
		cmdId: `cmd-${name}`,
		exitCode: 0,
		stdout: vi.fn().mockResolvedValue(pid),
		stderr: vi.fn().mockResolvedValue(""),
		wait: vi.fn(),
		kill: vi.fn().mockResolvedValue(undefined),
	};
	command.wait.mockResolvedValue(command);
	return {
		name,
		status: "running",
		fs: {
			readFile: vi.fn().mockResolvedValue("file"),
			writeFile: vi.fn().mockResolvedValue(undefined),
			appendFile: vi.fn().mockResolvedValue(undefined),
			readdir: vi.fn().mockResolvedValue([]),
			stat: vi.fn().mockResolvedValue({ isFile: () => true }),
			exists: vi.fn().mockResolvedValue(true),
			mkdir: vi.fn().mockResolvedValue(undefined),
			rm: vi.fn().mockResolvedValue(undefined),
			rename: vi.fn().mockResolvedValue(undefined),
		},
		runCommand: vi.fn().mockResolvedValue(command),
		domain: vi.fn((port: number) => `https://${name}-${port}.vercel.run`),
		stop: vi.fn().mockResolvedValue(undefined),
		delete: vi.fn().mockResolvedValue(undefined),
		extendTimeout: vi.fn().mockResolvedValue(undefined),
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	vercel.create.mockResolvedValue(vercel.sandbox);
	vercel.getOrCreate.mockResolvedValue(vercel.sandbox);
	vercel.get.mockResolvedValue(vercel.sandbox);
	vercel.stdout.mockResolvedValue("ok\n");
	vercel.stderr.mockResolvedValue("");
	vercel.wait.mockResolvedValue(vercel.command);
	vercel.kill.mockResolvedValue(undefined);
	vercel.readFile.mockResolvedValue("file");
	vercel.writeFile.mockResolvedValue(undefined);
	vercel.appendFile.mockResolvedValue(undefined);
	vercel.readdir.mockResolvedValue([{ name: "a.txt", isFile: () => true }]);
	vercel.stat.mockResolvedValue({
		size: 4,
		mtimeMs: 10,
		mode: 33188,
		isFile: () => true,
		isDirectory: () => false,
		isSymbolicLink: () => false,
	});
	vercel.exists.mockResolvedValue(true);
	vercel.mkdir.mockResolvedValue(undefined);
	vercel.rm.mockResolvedValue(undefined);
	vercel.rename.mockResolvedValue(undefined);
	vercel.runCommand.mockResolvedValue(vercel.command);
	vercel.domain.mockReturnValue("https://app.vercel.run");
	vercel.stop.mockResolvedValue(undefined);
	vercel.destroy.mockResolvedValue(undefined);
	vercel.extendTimeout.mockResolvedValue(undefined);
});

describe("@parel/sandbox-vercel", () => {
	const config = { token: "t", teamId: "team", projectId: "proj", name: "parel-agent" };

	it("gets or creates a named sandbox and provides parel.sandbox", async () => {
		const h = makeHarness(config);
		await sandboxPlugin.setup(h.ctx);
		await h.hooks.get("session:start")?.({} as never);

		expect(vercel.getOrCreate).toHaveBeenCalledWith({
			token: "t",
			teamId: "team",
			projectId: "proj",
			name: "parel-agent",
		});
		const capability = h.provided.get(PAREL_SANDBOX_CAPABILITY) as SandboxCapability;
		expect(capability.provider).toBe("vercel");
		expect(capability.id).toBe("parel-agent");
	});

	it("maps exec, spawn, fs, and ports to the standard capability", async () => {
		const h = makeHarness(config);
		await sandboxPlugin.setup(h.ctx);
		await h.hooks.get("session:start")?.({} as never);
		const capability = h.provided.get(PAREL_SANDBOX_CAPABILITY) as SandboxCapability;

		const result = await capability.process?.exec(["node", "-v"], {
			cwd: "/work",
			env: { A: "B" },
			timeoutMs: 1000,
		});
		expect(vercel.runCommand).toHaveBeenCalledWith({
			cmd: "node",
			args: ["-v"],
			cwd: "/work",
			env: { A: "B" },
			timeoutMs: 1000,
		});
		expect(result?.stdout).toBe("ok\n");

		vercel.runCommand.mockResolvedValueOnce(vercel.detached);
		const handle = await capability.process?.spawn?.(["sleep", "1"]);
		expect(handle?.id).toBe("cmd-2");
		expect(await handle?.status()).toBe("running");
		await handle?.kill("SIGTERM");
		expect(vercel.kill).toHaveBeenCalledWith("SIGTERM");

		expect(await capability.fs?.readFile("/tmp/a.txt")).toBe("file");
		await capability.fs?.writeFile("/tmp/a.txt", "next");
		expect(vercel.writeFile).toHaveBeenCalledWith("/tmp/a.txt", "next");
		expect(await capability.fs?.listDir("/tmp")).toEqual([{ name: "a.txt", type: "file" }]);
		expect(await capability.ports?.expose(3000)).toEqual({
			port: 3000,
			url: "https://app.vercel.run",
			protocol: "https",
		});
	});

	it("deletes the sandbox on session:end by default", async () => {
		const h = makeHarness(config);
		await sandboxPlugin.setup(h.ctx);
		await h.hooks.get("session:start")?.({} as never);
		await h.hooks.get("session:end")?.({} as never);
		expect(vercel.destroy).toHaveBeenCalledOnce();
	});

	it("per-session lifecycle.stop stops the sandbox without deleting it", async () => {
		const h = makeHarness(config);
		await sandboxPlugin.setup(h.ctx);
		await h.hooks.get("session:start")?.({} as never);
		const capability = h.provided.get(PAREL_SANDBOX_CAPABILITY) as SandboxCapability;
		await capability.lifecycle?.stop();
		// Without an instance store, stop preserves the named sandbox for reconnect.
		expect(vercel.stop).toHaveBeenCalled();
		expect(vercel.destroy).not.toHaveBeenCalled();
	});

	describe("instance mode (ctx.instanceStore present)", () => {
		// No `name` in config: a managed instance owns the handle, not the user.
		const base = { token: "t", teamId: "team", projectId: "proj" };

		it("adopts the instance's existing sandbox on session:start instead of creating", async () => {
			const istore = makeInstanceStore();
			await istore.set("vercel_sandbox_name", "v-shared");
			vercel.get.mockResolvedValue(makeSb("v-shared"));

			const h = makeHarness(base, istore);
			await sandboxPlugin.setup(h.ctx);
			await h.hooks.get("session:start")?.({} as never);

			expect(vercel.get).toHaveBeenCalledWith({
				name: "v-shared",
				token: "t",
				teamId: "team",
				projectId: "proj",
			});
			expect(vercel.create).not.toHaveBeenCalled();
			expect(vercel.getOrCreate).not.toHaveBeenCalled();
			const capability = h.provided.get(PAREL_SANDBOX_CAPABILITY) as SandboxCapability;
			expect(capability.id).toBe("v-shared");
		});

		it("cold-start race: exactly one sibling wins, the loser reaps its orphan and adopts", async () => {
			const istore = makeInstanceStore();
			const sbA = makeSb("v-a");
			const sbB = makeSb("v-b");
			vercel.create.mockResolvedValueOnce(sbA).mockResolvedValueOnce(sbB);
			vercel.get.mockImplementation(async ({ name }: { name: string }) =>
				name === "v-a" ? sbA : sbB,
			);

			const hA = makeHarness(base, istore);
			const hB = makeHarness(base, istore);
			await sandboxPlugin.setup(hA.ctx);
			await sandboxPlugin.setup(hB.ctx);
			await Promise.all([
				hA.hooks.get("session:start")?.({} as never),
				hB.hooks.get("session:start")?.({} as never),
			]);

			const winner = (await istore.get<string>("vercel_sandbox_name"))?.value;
			expect(["v-a", "v-b"]).toContain(winner);
			const loser = winner === "v-a" ? sbB : sbA;
			const won = winner === "v-a" ? sbA : sbB;
			expect(loser.delete).toHaveBeenCalled();
			expect(won.delete).not.toHaveBeenCalled();
		});

		it("session:end releases the local handle but never kills the shared sandbox", async () => {
			const istore = makeInstanceStore();
			await istore.set("vercel_sandbox_name", "v-shared");
			const shared = makeSb("v-shared");
			vercel.get.mockResolvedValue(shared);

			const h = makeHarness(base, istore);
			await sandboxPlugin.setup(h.ctx);
			await h.hooks.get("session:start")?.({} as never);
			await h.hooks.get("session:end")?.({} as never);

			expect(shared.delete).not.toHaveBeenCalled();
			expect((await istore.get<string>("vercel_sandbox_name"))?.value).toBe("v-shared");
			// The local handle was released — the sandbox must not report as running.
			const capability = h.provided.get(PAREL_SANDBOX_CAPABILITY) as SandboxCapability;
			expect(await capability.lifecycle?.isRunning()).toBe(false);
		});

		it("migrates a live legacy per-session sandbox into the instance store", async () => {
			const istore = makeInstanceStore();
			vercel.get.mockResolvedValue(makeSb("v-legacy"));

			const h = makeHarness(base, istore);
			await h.store.set("vercel_sandbox_name", "v-legacy");
			await sandboxPlugin.setup(h.ctx);
			await h.hooks.get("session:start")?.({} as never);

			expect((await istore.get<string>("vercel_sandbox_name"))?.value).toBe("v-legacy");
			expect(await h.store.get("vercel_sandbox_name")).toBeNull();
			expect(vercel.create).not.toHaveBeenCalled();
		});

		it("migrates legacy process/port records along with a promoted sandbox", async () => {
			const istore = makeInstanceStore();
			vercel.get.mockResolvedValue(makeSb("v-legacy"));

			const h = makeHarness(base, istore);
			await h.store.set("vercel_sandbox_name", "v-legacy");
			await h.store.set("sandbox_process:p1", { id: "p1", pid: 9, status: "running" });
			await h.store.set("sandbox_port:3000", { id: "3000", port: 3000 });
			await sandboxPlugin.setup(h.ctx);
			await h.hooks.get("session:start")?.({} as never);

			expect(await istore.list("sandbox_process:")).toEqual(["sandbox_process:p1"]);
			expect(await istore.list("sandbox_port:")).toEqual(["sandbox_port:3000"]);
			expect(h.store.map.size).toBe(0);
		});

		it("drops ghost process records when the legacy sandbox is reaped", async () => {
			const istore = makeInstanceStore();
			await istore.set("vercel_sandbox_name", "v-shared");
			const shared = makeSb("v-shared");
			const legacy = makeSb("v-legacy");
			vercel.get.mockImplementation(async ({ name }: { name: string }) =>
				name === "v-shared" ? shared : legacy,
			);

			const h = makeHarness(base, istore);
			await h.store.set("vercel_sandbox_name", "v-legacy");
			await h.store.set("sandbox_process:p1", { id: "p1", pid: 9, status: "running" });
			await sandboxPlugin.setup(h.ctx);
			await h.hooks.get("session:start")?.({} as never);

			expect(await istore.list("sandbox_process:")).toEqual([]);
			expect(legacy.delete).toHaveBeenCalled();
			expect(h.store.map.size).toBe(0);
		});

		it("reaps its legacy sandbox when a sibling's is already authoritative", async () => {
			const istore = makeInstanceStore();
			await istore.set("vercel_sandbox_name", "v-shared");
			const shared = makeSb("v-shared");
			const legacy = makeSb("v-legacy");
			vercel.get.mockImplementation(async ({ name }: { name: string }) =>
				name === "v-shared" ? shared : legacy,
			);

			const h = makeHarness(base, istore);
			await h.store.set("vercel_sandbox_name", "v-legacy");
			await sandboxPlugin.setup(h.ctx);
			await h.hooks.get("session:start")?.({} as never);

			expect(legacy.delete).toHaveBeenCalled();
			expect((await istore.get<string>("vercel_sandbox_name"))?.value).toBe("v-shared");
			expect(await h.store.get("vercel_sandbox_name")).toBeNull();
		});

		it("replaces an unreachable shared sandbox via versioned cas and drops its records", async () => {
			const istore = makeInstanceStore();
			await istore.set("vercel_sandbox_name", "v-dead");
			await istore.set("sandbox_process:p1", { id: "p1", pid: 9, status: "running" });
			const fresh = makeSb("v-fresh");
			vercel.create.mockResolvedValue(fresh);
			vercel.get.mockImplementation(async ({ name }: { name: string }) => {
				if (name === "v-dead") throw new Error("gone");
				return fresh;
			});

			const h = makeHarness(base, istore);
			await sandboxPlugin.setup(h.ctx);
			await h.hooks.get("session:start")?.({} as never);

			expect((await istore.get<string>("vercel_sandbox_name"))?.value).toBe("v-fresh");
			expect(await istore.list("sandbox_process:")).toEqual([]);
		});

		it("does not adopt a sandbox superseded during the reconnect window", async () => {
			const istore = makeInstanceStore();
			await istore.set("vercel_sandbox_name", "v-old");
			const oldSb = makeSb("v-old");
			const newSb = makeSb("v-new");
			vercel.get.mockImplementation(async ({ name }: { name: string }) => {
				if (name === "v-old") {
					await istore.set("vercel_sandbox_name", "v-new");
					return oldSb;
				}
				return newSb;
			});

			const h = makeHarness(base, istore);
			await sandboxPlugin.setup(h.ctx);
			await h.hooks.get("session:start")?.({} as never);

			const capability = h.provided.get(PAREL_SANDBOX_CAPABILITY) as SandboxCapability;
			expect(capability.id).toBe("v-new");
		});

		it("drops a cached handle when a sibling replaced the shared sandbox", async () => {
			const istore = makeInstanceStore();
			await istore.set("vercel_sandbox_name", "v-old");
			const oldSb = makeSb("v-old");
			const newSb = makeSb("v-new");
			newSb.fs.readFile.mockResolvedValue("from new");
			vercel.get.mockImplementation(async ({ name }: { name: string }) =>
				name === "v-old" ? oldSb : newSb,
			);

			const h = makeHarness(base, istore);
			await sandboxPlugin.setup(h.ctx);
			await h.hooks.get("session:start")?.({} as never); // caches v-old

			await istore.set("vercel_sandbox_name", "v-new"); // sibling swaps

			const capability = h.provided.get(PAREL_SANDBOX_CAPABILITY) as SandboxCapability;
			expect(await capability.fs?.readFile("/x")).toBe("from new");
		});

		it("explicit lifecycle.stop kills the instance sandbox and clears the handle", async () => {
			const istore = makeInstanceStore();
			await istore.set("vercel_sandbox_name", "v-shared");
			const shared = makeSb("v-shared");
			vercel.get.mockResolvedValue(shared);

			const h = makeHarness(base, istore);
			await sandboxPlugin.setup(h.ctx);
			await h.hooks.get("session:start")?.({} as never);
			const capability = h.provided.get(PAREL_SANDBOX_CAPABILITY) as SandboxCapability;
			await capability.lifecycle?.stop();

			expect(shared.delete).toHaveBeenCalled();
			expect(await istore.get("vercel_sandbox_name")).toBeNull();
		});

		it("skips the kill when lifecycle.stop loses the retire race", async () => {
			const istore = makeInstanceStore();
			await istore.set("vercel_sandbox_name", "v-shared");
			const shared = makeSb("v-shared");
			vercel.get.mockResolvedValue(shared);
			istore.casDelete = async () => false;

			const h = makeHarness(base, istore);
			await sandboxPlugin.setup(h.ctx);
			await h.hooks.get("session:start")?.({} as never);
			const capability = h.provided.get(PAREL_SANDBOX_CAPABILITY) as SandboxCapability;
			await capability.lifecycle?.stop();

			expect(shared.delete).not.toHaveBeenCalled();
			expect((await istore.get<string>("vercel_sandbox_name"))?.value).toBe("v-shared");
		});

		it("destroys the sandbox on session:end for an ephemeral instance", async () => {
			const istore = makeInstanceStore();
			const sb = makeSb("v-eph");
			vercel.create.mockResolvedValue(sb);
			vercel.get.mockResolvedValue(sb);

			const h = makeHarness(base, istore);
			(h.ctx as { instance?: { key: string | null; ephemeral: boolean } }).instance = {
				key: null,
				ephemeral: true,
			};
			await sandboxPlugin.setup(h.ctx);
			await h.hooks.get("session:start")?.({} as never);
			await h.hooks.get("session:end")?.({} as never);

			expect(sb.delete).toHaveBeenCalled();
		});

		it("connects an externally pinned name (config.name) without racing or migrating", async () => {
			const istore = makeInstanceStore();
			vercel.getOrCreate.mockResolvedValue(makeSb("v-external"));

			const h = makeHarness({ ...base, name: "v-external" }, istore);
			await sandboxPlugin.setup(h.ctx);
			await h.hooks.get("session:start")?.({} as never);

			// External pin: getOrCreate by the pinned name, no instance-store handle,
			// no versioned get/cas.
			expect(vercel.getOrCreate).toHaveBeenCalledWith(
				expect.objectContaining({ name: "v-external" }),
			);
			expect(vercel.get).not.toHaveBeenCalled();
			expect(await istore.get("vercel_sandbox_name")).toBeNull();

			// SessionEnd must not kill an externally owned sandbox.
			const shared = makeSb("v-external");
			vercel.get.mockResolvedValue(shared);
			await h.hooks.get("session:end")?.({} as never);
			expect(shared.delete).not.toHaveBeenCalled();
		});

		it("clears shared process/port records when the sandbox is stopped", async () => {
			const istore = makeInstanceStore();
			await istore.set("vercel_sandbox_name", "v-shared");
			await istore.set("sandbox_process:p1", { id: "p1", pid: 9, status: "running" });
			await istore.set("sandbox_port:3000", { id: "3000", port: 3000 });
			vercel.get.mockResolvedValue(makeSb("v-shared"));

			const h = makeHarness(base, istore);
			await sandboxPlugin.setup(h.ctx);
			await h.hooks.get("session:start")?.({} as never);
			const capability = h.provided.get(PAREL_SANDBOX_CAPABILITY) as SandboxCapability;
			await capability.lifecycle?.stop();

			// The killed sandbox took its processes/ports with it — no ghost records.
			expect(await istore.list("sandbox_process:")).toEqual([]);
			expect(await istore.list("sandbox_port:")).toEqual([]);
		});

		it("stores process records in the instance store so siblings see them", async () => {
			const istore = makeInstanceStore();
			const sb = makeSb("v-shared");
			vercel.create.mockResolvedValue(sb);
			vercel.get.mockResolvedValue(sb);

			const h = makeHarness(base, istore);
			await sandboxPlugin.setup(h.ctx);
			await h.hooks.get("session:start")?.({} as never);
			const processes = h.provided.get("process") as SandboxProcessView;
			await processes.start("sleep 1000");

			expect(await istore.list("sandbox_process:")).toHaveLength(1);
			expect(h.store.map.size).toBe(0);
		});
	});
});
