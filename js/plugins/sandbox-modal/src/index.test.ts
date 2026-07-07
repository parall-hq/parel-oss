import {
	PAREL_SANDBOX_CAPABILITY,
	type SandboxCapability,
	type SandboxProcessView,
} from "@parel/capability-sandbox";
import type { HookHandler, LifecycleEvent, PluginContext } from "@parel/plugin-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";

const modal = vi.hoisted(() => {
	const readText = vi.fn();
	const readBytes = vi.fn();
	const writeText = vi.fn();
	const writeBytes = vi.fn();
	const listFiles = vi.fn();
	const stat = vi.fn();
	const makeDirectory = vi.fn();
	const remove = vi.fn();
	const exec = vi.fn();
	const tunnels = vi.fn();
	const terminate = vi.fn();
	const detach = vi.fn();
	const stdoutReadText = vi.fn();
	const stderrReadText = vi.fn();
	const wait = vi.fn();
	const process = {
		stdout: { readText: stdoutReadText },
		stderr: { readText: stderrReadText },
		wait,
	};
	const sandbox = {
		sandboxId: "modal-1",
		filesystem: {
			readText,
			readBytes,
			writeText,
			writeBytes,
			listFiles,
			stat,
			makeDirectory,
			remove,
		},
		exec,
		tunnels,
		terminate,
		detach,
	};
	const fromId = vi.fn();
	const fromName = vi.fn();
	const create = vi.fn();
	const appFromName = vi.fn();
	const fromRegistry = vi.fn();
	const ModalClient = vi.fn(function ModalClient(this: unknown, config: unknown) {
		return {
			config,
			apps: { fromName: appFromName },
			sandboxes: { fromId, fromName, create },
		};
	});
	const Image = { fromRegistry };
	return {
		ModalClient,
		Image,
		readText,
		readBytes,
		writeText,
		writeBytes,
		listFiles,
		stat,
		makeDirectory,
		remove,
		exec,
		tunnels,
		terminate,
		detach,
		stdoutReadText,
		stderrReadText,
		wait,
		process,
		sandbox,
		fromId,
		fromName,
		create,
		appFromName,
		fromRegistry,
	};
});

vi.mock("modal", () => ({
	ModalClient: modal.ModalClient,
	Image: modal.Image,
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
// need to tell a winner's handle from a loser's orphan. `pid` seeds the stdout
// that the process view parses when starting a background process.
function makeSb(id: string, pid = "4242") {
	return {
		sandboxId: id,
		filesystem: {
			readText: vi.fn().mockResolvedValue("file"),
			readBytes: vi.fn().mockResolvedValue(new Uint8Array([1])),
			writeText: vi.fn().mockResolvedValue(undefined),
			writeBytes: vi.fn().mockResolvedValue(undefined),
			listFiles: vi.fn().mockResolvedValue([]),
			stat: vi.fn().mockResolvedValue({}),
			makeDirectory: vi.fn().mockResolvedValue(undefined),
			remove: vi.fn().mockResolvedValue(undefined),
		},
		exec: vi.fn().mockResolvedValue({
			stdout: { readText: vi.fn().mockResolvedValue(pid) },
			stderr: { readText: vi.fn().mockResolvedValue("") },
			wait: vi.fn().mockResolvedValue(0),
		}),
		tunnels: vi.fn().mockResolvedValue({ 3000: { url: "https://modal.example" } }),
		terminate: vi.fn().mockResolvedValue(undefined),
		detach: vi.fn(),
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	modal.appFromName.mockResolvedValue({ appId: "app-1" });
	modal.fromRegistry.mockReturnValue({ image: "python:3.13" });
	modal.create.mockResolvedValue(modal.sandbox);
	modal.fromId.mockResolvedValue(modal.sandbox);
	modal.fromName.mockResolvedValue(modal.sandbox);
	modal.exec.mockResolvedValue(modal.process);
	modal.stdoutReadText.mockResolvedValue("ok\n");
	modal.stderrReadText.mockResolvedValue("");
	modal.wait.mockResolvedValue(0);
	modal.readText.mockResolvedValue("file");
	modal.readBytes.mockResolvedValue(new Uint8Array([1, 2, 3]));
	modal.writeText.mockResolvedValue(undefined);
	modal.writeBytes.mockResolvedValue(undefined);
	modal.listFiles.mockResolvedValue([{ name: "a.txt", type: "file", size: 4 }]);
	modal.stat.mockResolvedValue({ name: "a.txt", path: "/tmp/a.txt", type: "file", size: 4 });
	modal.makeDirectory.mockResolvedValue(undefined);
	modal.remove.mockResolvedValue(undefined);
	modal.tunnels.mockResolvedValue({ 3000: { url: "https://modal.example" } });
	modal.terminate.mockResolvedValue(undefined);
	modal.detach.mockReturnValue(undefined);
});

describe("@parel/sandbox-modal", () => {
	const TEST_MODAL_TOKEN = ["modal", "fixture"].join("-");
	const config = { tokenId: "id", tokenSecret: TEST_MODAL_TOKEN, appName: "parel-agent" };

	it("creates a Modal sandbox and provides parel.sandbox", async () => {
		const h = makeHarness(config);
		await sandboxPlugin.setup(h.ctx);
		await h.hooks.get("session:start")?.({} as never);

		expect(modal.ModalClient).toHaveBeenCalledWith({
			tokenId: "id",
			tokenSecret: TEST_MODAL_TOKEN,
			environment: undefined,
		});
		expect(modal.appFromName).toHaveBeenCalledWith("parel-agent", {
			createIfMissing: true,
			environment: undefined,
		});
		expect(modal.create).toHaveBeenCalled();

		const capability = h.provided.get(PAREL_SANDBOX_CAPABILITY) as SandboxCapability;
		expect(capability.provider).toBe("modal");
		expect(capability.id).toBe("modal-1");
	});

	it("maps exec, fs, and ports to the standard capability", async () => {
		const h = makeHarness(config);
		await sandboxPlugin.setup(h.ctx);
		await h.hooks.get("session:start")?.({} as never);
		const capability = h.provided.get(PAREL_SANDBOX_CAPABILITY) as SandboxCapability;

		const result = await capability.process?.exec(["python", "-V"], {
			cwd: "/work",
			env: { A: "B" },
			timeoutMs: 1000,
		});
		expect(modal.exec).toHaveBeenCalledWith(["python", "-V"], {
			mode: "text",
			workdir: "/work",
			timeoutMs: 1000,
			env: { A: "B" },
		});
		expect(result).toEqual({
			stdout: "ok\n",
			stderr: "",
			exitCode: 0,
			metadata: { provider: "modal" },
		});

		expect(await capability.fs?.readFile("/tmp/a.txt")).toBe("file");
		await capability.fs?.writeFile("/tmp/a.txt", "next");
		expect(modal.writeText).toHaveBeenCalledWith("next", "/tmp/a.txt");
		expect(await capability.fs?.listDir("/tmp")).toEqual([
			{ name: "a.txt", path: undefined, type: "file", size: 4, mtimeMs: undefined },
		]);
		expect(await capability.ports?.expose(3000)).toEqual({
			port: 3000,
			url: "https://modal.example",
			protocol: "https",
		});
	});

	it("terminates the sandbox on session:end by default", async () => {
		const h = makeHarness(config);
		await sandboxPlugin.setup(h.ctx);
		await h.hooks.get("session:start")?.({} as never);
		await h.hooks.get("session:end")?.({} as never);
		expect(modal.terminate).toHaveBeenCalledOnce();
	});

	describe("instance mode (ctx.instanceStore present)", () => {
		const base = { tokenId: "id", tokenSecret: TEST_MODAL_TOKEN, appName: "parel-agent" };

		it("adopts the instance's existing sandbox on session:start instead of creating", async () => {
			const istore = makeInstanceStore();
			await istore.set("modal_sandbox_id", "modal-shared");
			modal.fromId.mockResolvedValue(makeSb("modal-shared"));

			const h = makeHarness(base, istore);
			await sandboxPlugin.setup(h.ctx);
			await h.hooks.get("session:start")?.({} as never);

			expect(modal.fromId).toHaveBeenCalledWith("modal-shared");
			expect(modal.create).not.toHaveBeenCalled();
			const capability = h.provided.get(PAREL_SANDBOX_CAPABILITY) as SandboxCapability;
			expect(capability.id).toBe("modal-shared");
		});

		it("cold-start race: exactly one sibling wins, the loser reaps its orphan and adopts", async () => {
			const istore = makeInstanceStore();
			const sbA = makeSb("modal-a");
			const sbB = makeSb("modal-b");
			modal.create.mockResolvedValueOnce(sbA).mockResolvedValueOnce(sbB);
			modal.fromId.mockImplementation(async (id: string) => (id === "modal-a" ? sbA : sbB));

			const hA = makeHarness(base, istore);
			const hB = makeHarness(base, istore);
			await sandboxPlugin.setup(hA.ctx);
			await sandboxPlugin.setup(hB.ctx);
			await Promise.all([
				hA.hooks.get("session:start")?.({} as never),
				hB.hooks.get("session:start")?.({} as never),
			]);

			const winner = (await istore.get<string>("modal_sandbox_id"))?.value;
			expect(["modal-a", "modal-b"]).toContain(winner);
			const loser = winner === "modal-a" ? sbB : sbA;
			const won = winner === "modal-a" ? sbA : sbB;
			expect(loser.terminate).toHaveBeenCalled();
			expect(won.terminate).not.toHaveBeenCalled();
		});

		it("session:end releases the local handle but never kills the shared sandbox", async () => {
			const istore = makeInstanceStore();
			await istore.set("modal_sandbox_id", "modal-shared");
			const shared = makeSb("modal-shared");
			modal.fromId.mockResolvedValue(shared);

			const h = makeHarness(base, istore);
			await sandboxPlugin.setup(h.ctx);
			await h.hooks.get("session:start")?.({} as never);
			await h.hooks.get("session:end")?.({} as never);

			expect(shared.terminate).not.toHaveBeenCalled();
			expect((await istore.get<string>("modal_sandbox_id"))?.value).toBe("modal-shared");
			const capability = h.provided.get(PAREL_SANDBOX_CAPABILITY) as SandboxCapability;
			expect(await capability.lifecycle?.isRunning()).toBe(false);
		});

		it("migrates a live legacy per-session sandbox into the instance store", async () => {
			const istore = makeInstanceStore();
			const legacy = makeSb("modal-legacy");
			modal.fromId.mockResolvedValue(legacy);

			const h = makeHarness(base, istore);
			await h.store.set("modal_sandbox_id", "modal-legacy");
			await sandboxPlugin.setup(h.ctx);
			await h.hooks.get("session:start")?.({} as never);

			expect((await istore.get<string>("modal_sandbox_id"))?.value).toBe("modal-legacy");
			expect(await h.store.get("modal_sandbox_id")).toBeNull();
			expect(modal.create).not.toHaveBeenCalled();
			expect(legacy.terminate).not.toHaveBeenCalled();
		});

		it("migrates legacy process/port records along with a promoted sandbox", async () => {
			const istore = makeInstanceStore();
			modal.fromId.mockResolvedValue(makeSb("modal-legacy"));

			const h = makeHarness(base, istore);
			await h.store.set("modal_sandbox_id", "modal-legacy");
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
			await istore.set("modal_sandbox_id", "modal-shared");
			const shared = makeSb("modal-shared");
			const legacy = makeSb("modal-legacy");
			modal.fromId.mockImplementation(async (id: string) =>
				id === "modal-shared" ? shared : legacy,
			);

			const h = makeHarness(base, istore);
			await h.store.set("modal_sandbox_id", "modal-legacy");
			await h.store.set("sandbox_process:p1", { id: "p1", pid: 9, status: "running" });
			await sandboxPlugin.setup(h.ctx);
			await h.hooks.get("session:start")?.({} as never);

			expect(await istore.list("sandbox_process:")).toEqual([]);
			expect(legacy.terminate).toHaveBeenCalled();
			expect(h.store.map.size).toBe(0);
		});

		it("reaps its legacy sandbox when a sibling's is already authoritative", async () => {
			const istore = makeInstanceStore();
			await istore.set("modal_sandbox_id", "modal-shared");
			const shared = makeSb("modal-shared");
			const legacy = makeSb("modal-legacy");
			modal.fromId.mockImplementation(async (id: string) =>
				id === "modal-shared" ? shared : legacy,
			);

			const h = makeHarness(base, istore);
			await h.store.set("modal_sandbox_id", "modal-legacy");
			await sandboxPlugin.setup(h.ctx);
			await h.hooks.get("session:start")?.({} as never);

			expect(legacy.terminate).toHaveBeenCalled();
			expect((await istore.get<string>("modal_sandbox_id"))?.value).toBe("modal-shared");
			expect(await h.store.get("modal_sandbox_id")).toBeNull();
		});

		it("replaces an unreachable shared sandbox via versioned cas and drops its records", async () => {
			const istore = makeInstanceStore();
			await istore.set("modal_sandbox_id", "modal-dead");
			await istore.set("sandbox_process:p1", { id: "p1", pid: 9, status: "running" });
			const fresh = makeSb("modal-fresh");
			modal.create.mockResolvedValue(fresh);
			modal.fromId.mockImplementation(async (id: string) => {
				if (id === "modal-dead") throw new Error("gone");
				return fresh;
			});

			const h = makeHarness(base, istore);
			await sandboxPlugin.setup(h.ctx);
			await h.hooks.get("session:start")?.({} as never);

			expect((await istore.get<string>("modal_sandbox_id"))?.value).toBe("modal-fresh");
			expect(await istore.list("sandbox_process:")).toEqual([]);
		});

		it("does not adopt a sandbox superseded during the reconnect window", async () => {
			const istore = makeInstanceStore();
			await istore.set("modal_sandbox_id", "modal-old");
			const oldSb = makeSb("modal-old");
			const newSb = makeSb("modal-new");
			modal.fromId.mockImplementation(async (id: string) => {
				if (id === "modal-old") {
					await istore.set("modal_sandbox_id", "modal-new");
					return oldSb;
				}
				return newSb;
			});

			const h = makeHarness(base, istore);
			await sandboxPlugin.setup(h.ctx);
			await h.hooks.get("session:start")?.({} as never);

			const capability = h.provided.get(PAREL_SANDBOX_CAPABILITY) as SandboxCapability;
			expect(capability.id).toBe("modal-new");
		});

		it("drops a cached handle when a sibling replaced the shared sandbox", async () => {
			const istore = makeInstanceStore();
			await istore.set("modal_sandbox_id", "modal-old");
			const oldSb = makeSb("modal-old");
			const newSb = makeSb("modal-new");
			newSb.filesystem.readText.mockResolvedValue("from new");
			modal.fromId.mockImplementation(async (id: string) => (id === "modal-old" ? oldSb : newSb));

			const h = makeHarness(base, istore);
			await sandboxPlugin.setup(h.ctx);
			await h.hooks.get("session:start")?.({} as never); // caches modal-old

			await istore.set("modal_sandbox_id", "modal-new"); // sibling swaps

			const capability = h.provided.get(PAREL_SANDBOX_CAPABILITY) as SandboxCapability;
			expect(await capability.fs?.readFile("/x")).toBe("from new");
		});

		it("explicit lifecycle.stop kills the instance sandbox and clears the handle", async () => {
			const istore = makeInstanceStore();
			await istore.set("modal_sandbox_id", "modal-shared");
			const shared = makeSb("modal-shared");
			modal.fromId.mockResolvedValue(shared);

			const h = makeHarness(base, istore);
			await sandboxPlugin.setup(h.ctx);
			await h.hooks.get("session:start")?.({} as never);
			const capability = h.provided.get(PAREL_SANDBOX_CAPABILITY) as SandboxCapability;
			await capability.lifecycle?.stop();

			expect(shared.terminate).toHaveBeenCalled();
			expect(await istore.get("modal_sandbox_id")).toBeNull();
		});

		it("skips the kill when lifecycle.stop loses the retire race", async () => {
			const istore = makeInstanceStore();
			await istore.set("modal_sandbox_id", "modal-shared");
			const shared = makeSb("modal-shared");
			modal.fromId.mockResolvedValue(shared);
			istore.casDelete = async () => false;

			const h = makeHarness(base, istore);
			await sandboxPlugin.setup(h.ctx);
			await h.hooks.get("session:start")?.({} as never);
			const capability = h.provided.get(PAREL_SANDBOX_CAPABILITY) as SandboxCapability;
			await capability.lifecycle?.stop();

			expect(shared.terminate).not.toHaveBeenCalled();
			expect((await istore.get<string>("modal_sandbox_id"))?.value).toBe("modal-shared");
		});

		it("destroys the sandbox on session:end for an ephemeral instance", async () => {
			const istore = makeInstanceStore();
			const sb = makeSb("modal-eph");
			modal.create.mockResolvedValue(sb);
			modal.fromId.mockResolvedValue(sb);

			const h = makeHarness(base, istore);
			(h.ctx as { instance?: { key: string | null; ephemeral: boolean } }).instance = {
				key: null,
				ephemeral: true,
			};
			await sandboxPlugin.setup(h.ctx);
			await h.hooks.get("session:start")?.({} as never);
			await h.hooks.get("session:end")?.({} as never);

			expect(sb.terminate).toHaveBeenCalled();
		});

		it("connects an externally pinned sandboxId without racing or migrating", async () => {
			const istore = makeInstanceStore();
			const pinned = makeSb("modal-external");
			modal.fromId.mockResolvedValue(pinned);

			const h = makeHarness({ ...base, sandboxId: "modal-external" }, istore);
			await sandboxPlugin.setup(h.ctx);
			await h.hooks.get("session:start")?.({} as never);

			// External pin: connect directly, do not seed the instance-store handle.
			expect(modal.fromId).toHaveBeenCalledWith("modal-external");
			expect(modal.create).not.toHaveBeenCalled();
			expect(await istore.get("modal_sandbox_id")).toBeNull();

			// SessionEnd must not kill an externally owned sandbox.
			await h.hooks.get("session:end")?.({} as never);
			expect(pinned.terminate).not.toHaveBeenCalled();
		});

		it("reconnects an externally pinned name via fromName instead of cold-creating", async () => {
			const istore = makeInstanceStore();
			const named = makeSb("modal-named");
			modal.fromName.mockResolvedValue(named);

			// config.name is Modal's documented reconnect-a-running-named-sandbox path;
			// instance mode must honor it (external), not create a fresh sandbox.
			const h = makeHarness({ ...base, name: "running-sbx" }, istore);
			await sandboxPlugin.setup(h.ctx);
			await h.hooks.get("session:start")?.({} as never);

			expect(modal.fromName).toHaveBeenCalledWith("parel-agent", "running-sbx", {
				environment: undefined,
			});
			expect(modal.create).not.toHaveBeenCalled();
			expect(await istore.get("modal_sandbox_id")).toBeNull();

			await h.hooks.get("session:end")?.({} as never);
			expect(named.terminate).not.toHaveBeenCalled();
		});

		it("clears shared process/port records when the sandbox is stopped", async () => {
			const istore = makeInstanceStore();
			await istore.set("modal_sandbox_id", "modal-shared");
			await istore.set("sandbox_process:p1", { id: "p1", pid: 9, status: "running" });
			await istore.set("sandbox_port:3000", { id: "3000", port: 3000 });
			modal.fromId.mockResolvedValue(makeSb("modal-shared"));

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
			const sb = makeSb("modal-shared");
			modal.create.mockResolvedValue(sb);
			modal.fromId.mockResolvedValue(sb);

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
