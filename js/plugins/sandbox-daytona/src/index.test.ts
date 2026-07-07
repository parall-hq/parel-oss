import {
	PAREL_SANDBOX_CAPABILITY,
	type SandboxCapability,
	type SandboxProcessView,
} from "@parel/capability-sandbox";
import type { HookHandler, LifecycleEvent, PluginContext } from "@parel/plugin-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";

const daytona = vi.hoisted(() => {
	const downloadFile = vi.fn();
	const uploadFile = vi.fn();
	const listFiles = vi.fn();
	const getFileDetails = vi.fn();
	const createFolder = vi.fn();
	const deleteFile = vi.fn();
	const moveFiles = vi.fn();
	const executeCommand = vi.fn();
	const getWorkDir = vi.fn();
	const getPreviewLink = vi.fn();
	const start = vi.fn();
	const stop = vi.fn();
	const destroy = vi.fn();
	const sandbox = {
		id: "daytona-1",
		name: "agent",
		state: "started",
		fs: {
			downloadFile,
			uploadFile,
			listFiles,
			getFileDetails,
			createFolder,
			deleteFile,
			moveFiles,
		},
		process: { executeCommand },
		getWorkDir,
		getPreviewLink,
		start,
		stop,
		delete: destroy,
	};
	const create = vi.fn();
	const get = vi.fn();
	const Daytona = vi.fn(function Daytona(this: unknown, config: unknown) {
		return { config, create, get };
	});
	return {
		Daytona,
		create,
		get,
		downloadFile,
		uploadFile,
		listFiles,
		getFileDetails,
		createFolder,
		deleteFile,
		moveFiles,
		executeCommand,
		getWorkDir,
		getPreviewLink,
		start,
		stop,
		destroy,
		sandbox,
	};
});

vi.mock("@daytona/sdk", () => ({
	Daytona: daytona.Daytona,
}));

import sandboxPlugin from "./index.js";

const TEST_API_KEY = ["daytona", "key"].join("-");

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
// need to tell a winner's handle from a loser's orphan.
function makeSb(id: string) {
	return {
		id,
		name: id,
		state: "started",
		fs: {
			downloadFile: vi.fn().mockResolvedValue(Buffer.from("hi")),
			uploadFile: vi.fn().mockResolvedValue(undefined),
			listFiles: vi.fn().mockResolvedValue([]),
			getFileDetails: vi.fn().mockResolvedValue({}),
			createFolder: vi.fn().mockResolvedValue(undefined),
			deleteFile: vi.fn().mockResolvedValue(undefined),
			moveFiles: vi.fn().mockResolvedValue(undefined),
		},
		process: {
			executeCommand: vi
				.fn()
				.mockResolvedValue({ exitCode: 0, result: "", artifacts: { stdout: "" } }),
		},
		getWorkDir: vi.fn().mockResolvedValue("/workspace"),
		getPreviewLink: vi.fn().mockResolvedValue({ url: "https://preview", token: "t" }),
		start: vi.fn().mockResolvedValue(undefined),
		stop: vi.fn().mockResolvedValue(undefined),
		delete: vi.fn().mockResolvedValue(undefined),
		refreshData: vi.fn().mockResolvedValue(undefined),
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	daytona.create.mockResolvedValue(daytona.sandbox);
	daytona.get.mockResolvedValue(daytona.sandbox);
	daytona.downloadFile.mockResolvedValue(Buffer.from("hello"));
	daytona.uploadFile.mockResolvedValue(undefined);
	daytona.listFiles.mockResolvedValue([{ name: "a.txt", type: "file", size: 5 }]);
	daytona.getFileDetails.mockResolvedValue({
		name: "a.txt",
		path: "/tmp/a.txt",
		type: "file",
		size: 5,
	});
	daytona.createFolder.mockResolvedValue(undefined);
	daytona.deleteFile.mockResolvedValue(undefined);
	daytona.moveFiles.mockResolvedValue(undefined);
	daytona.executeCommand.mockResolvedValue({
		exitCode: 0,
		result: "ok\n",
		artifacts: { stdout: "ok\n" },
	});
	daytona.getWorkDir.mockResolvedValue("/workspace");
	daytona.getPreviewLink.mockResolvedValue({ url: "https://preview.example", token: "tok" });
	daytona.start.mockResolvedValue(undefined);
	daytona.stop.mockResolvedValue(undefined);
	daytona.destroy.mockResolvedValue(undefined);
});

describe("@parel/sandbox-daytona", () => {
	it("connects a named sandbox on session:start and provides parel.sandbox", async () => {
		const h = makeHarness({ apiKey: TEST_API_KEY, target: "us", name: "agent" });
		await sandboxPlugin.setup(h.ctx);
		await h.hooks.get("session:start")?.({} as never);

		expect(daytona.Daytona).toHaveBeenCalledWith({
			apiKey: TEST_API_KEY,
			apiUrl: undefined,
			target: "us",
		});
		expect(daytona.get).toHaveBeenCalledWith("agent");
		expect(daytona.create).not.toHaveBeenCalled();

		const capability = h.provided.get(PAREL_SANDBOX_CAPABILITY) as SandboxCapability;
		expect(capability.provider).toBe("daytona");
		expect(capability.id).toBe("daytona-1");
		expect(capability.cwd).toBe("/workspace");
	});

	it("maps process, filesystem, and ports to the standard capability", async () => {
		const h = makeHarness({ apiKey: TEST_API_KEY, timeoutMs: 2000 });
		await sandboxPlugin.setup(h.ctx);
		await h.hooks.get("session:start")?.({} as never);
		const capability = h.provided.get(PAREL_SANDBOX_CAPABILITY) as SandboxCapability;

		const result = await capability.process?.exec(["python", "-V"], {
			cwd: "/workspace",
			env: { A: "B" },
			timeoutMs: 2000,
		});
		expect(daytona.executeCommand).toHaveBeenCalledWith("python -V", "/workspace", { A: "B" }, 2);
		expect(result).toEqual({
			stdout: "ok\n",
			stderr: "",
			exitCode: 0,
			metadata: { provider: "daytona" },
		});

		expect(await capability.fs?.readFile("/tmp/a.txt")).toBe("hello");
		await capability.fs?.writeFile("/tmp/a.txt", "next");
		expect(daytona.uploadFile).toHaveBeenCalledWith(Buffer.from("next"), "/tmp/a.txt", 2);
		expect(await capability.fs?.listDir("/tmp")).toEqual([
			{ name: "a.txt", path: "a.txt", type: "file", size: 5, mtimeMs: undefined },
		]);
		expect(await capability.ports?.expose(3000)).toEqual({
			port: 3000,
			url: "https://preview.example",
			protocol: "https",
			metadata: { token: "tok" },
		});
	});

	it("deletes the sandbox on session:end by default", async () => {
		const h = makeHarness({ apiKey: TEST_API_KEY });
		await sandboxPlugin.setup(h.ctx);
		await h.hooks.get("session:start")?.({} as never);
		await h.hooks.get("session:end")?.({} as never);
		expect(daytona.destroy).toHaveBeenCalledOnce();
	});

	it("per-session lifecycle.stop stops the sandbox without deleting it", async () => {
		const h = makeHarness({ apiKey: TEST_API_KEY });
		await sandboxPlugin.setup(h.ctx);
		await h.hooks.get("session:start")?.({} as never);
		const capability = h.provided.get(PAREL_SANDBOX_CAPABILITY) as SandboxCapability;
		await capability.lifecycle?.stop();
		// Without an instance store, stop preserves the sandbox/files for reconnect.
		expect(daytona.stop).toHaveBeenCalled();
		expect(daytona.destroy).not.toHaveBeenCalled();
	});

	describe("instance mode (ctx.instanceStore present)", () => {
		it("adopts the instance's existing sandbox on session:start instead of creating", async () => {
			const istore = makeInstanceStore();
			await istore.set("daytona_sandbox_id", "day-shared");
			daytona.get.mockResolvedValue(makeSb("day-shared"));

			const h = makeHarness({ apiKey: TEST_API_KEY }, istore);
			await sandboxPlugin.setup(h.ctx);
			await h.hooks.get("session:start")?.({} as never);

			expect(daytona.get).toHaveBeenCalledWith("day-shared");
			expect(daytona.create).not.toHaveBeenCalled();
			const capability = h.provided.get(PAREL_SANDBOX_CAPABILITY) as SandboxCapability;
			expect(capability.id).toBe("day-shared");
		});

		it("cold-start race: exactly one sibling wins, the loser reaps its orphan and adopts", async () => {
			const istore = makeInstanceStore();
			const sbA = makeSb("day-a");
			const sbB = makeSb("day-b");
			daytona.create.mockResolvedValueOnce(sbA).mockResolvedValueOnce(sbB);
			daytona.get.mockImplementation(async (id: string) => (id === "day-a" ? sbA : sbB));

			const hA = makeHarness({ apiKey: TEST_API_KEY }, istore);
			const hB = makeHarness({ apiKey: TEST_API_KEY }, istore);
			await sandboxPlugin.setup(hA.ctx);
			await sandboxPlugin.setup(hB.ctx);
			await Promise.all([
				hA.hooks.get("session:start")?.({} as never),
				hB.hooks.get("session:start")?.({} as never),
			]);

			const winner = (await istore.get<string>("daytona_sandbox_id"))?.value;
			expect(["day-a", "day-b"]).toContain(winner);
			const loser = winner === "day-a" ? sbB : sbA;
			const won = winner === "day-a" ? sbA : sbB;
			expect(loser.delete).toHaveBeenCalled();
			expect(won.delete).not.toHaveBeenCalled();
		});

		it("session:end releases the local handle but never kills the shared sandbox", async () => {
			const istore = makeInstanceStore();
			await istore.set("daytona_sandbox_id", "day-shared");
			const shared = makeSb("day-shared");
			daytona.get.mockResolvedValue(shared);

			const h = makeHarness({ apiKey: TEST_API_KEY }, istore);
			await sandboxPlugin.setup(h.ctx);
			await h.hooks.get("session:start")?.({} as never);
			await h.hooks.get("session:end")?.({} as never);

			expect(shared.delete).not.toHaveBeenCalled();
			expect((await istore.get<string>("daytona_sandbox_id"))?.value).toBe("day-shared");
			const capability = h.provided.get(PAREL_SANDBOX_CAPABILITY) as SandboxCapability;
			expect(await capability.lifecycle?.isRunning()).toBe(false);
		});

		it("migrates a live legacy per-session sandbox into the instance store", async () => {
			const istore = makeInstanceStore();
			const legacy = makeSb("day-legacy");
			daytona.get.mockResolvedValue(legacy);

			const h = makeHarness({ apiKey: TEST_API_KEY }, istore);
			await h.store.set("daytona_sandbox_id", "day-legacy");
			await sandboxPlugin.setup(h.ctx);
			await h.hooks.get("session:start")?.({} as never);

			expect((await istore.get<string>("daytona_sandbox_id"))?.value).toBe("day-legacy");
			expect(await h.store.get("daytona_sandbox_id")).toBeNull();
			expect(daytona.create).not.toHaveBeenCalled();
			expect(legacy.delete).not.toHaveBeenCalled();
		});

		it("migrates legacy process/port records along with a promoted sandbox", async () => {
			const istore = makeInstanceStore();
			daytona.get.mockResolvedValue(makeSb("day-legacy"));

			const h = makeHarness({ apiKey: TEST_API_KEY }, istore);
			await h.store.set("daytona_sandbox_id", "day-legacy");
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
			await istore.set("daytona_sandbox_id", "day-shared");
			const shared = makeSb("day-shared");
			const legacy = makeSb("day-legacy");
			daytona.get.mockImplementation(async (id: string) => (id === "day-shared" ? shared : legacy));

			const h = makeHarness({ apiKey: TEST_API_KEY }, istore);
			await h.store.set("daytona_sandbox_id", "day-legacy");
			await h.store.set("sandbox_process:p1", { id: "p1", pid: 9, status: "running" });
			await sandboxPlugin.setup(h.ctx);
			await h.hooks.get("session:start")?.({} as never);

			// The legacy sandbox was killed — its process records are ghosts and must
			// not pollute the shared instance's tables.
			expect(await istore.list("sandbox_process:")).toEqual([]);
			expect(legacy.delete).toHaveBeenCalled();
			expect(h.store.map.size).toBe(0);
		});

		it("reaps its legacy sandbox when a sibling's is already authoritative", async () => {
			const istore = makeInstanceStore();
			await istore.set("daytona_sandbox_id", "day-shared");
			const shared = makeSb("day-shared");
			const legacy = makeSb("day-legacy");
			daytona.get.mockImplementation(async (id: string) => (id === "day-shared" ? shared : legacy));

			const h = makeHarness({ apiKey: TEST_API_KEY }, istore);
			await h.store.set("daytona_sandbox_id", "day-legacy");
			await sandboxPlugin.setup(h.ctx);
			await h.hooks.get("session:start")?.({} as never);

			expect(legacy.delete).toHaveBeenCalled();
			expect((await istore.get<string>("daytona_sandbox_id"))?.value).toBe("day-shared");
			expect(await h.store.get("daytona_sandbox_id")).toBeNull();
		});

		it("replaces an unreachable shared sandbox via versioned cas and drops its records", async () => {
			const istore = makeInstanceStore();
			await istore.set("daytona_sandbox_id", "day-dead");
			// Records of the dead sandbox must not be inherited by the replacement.
			await istore.set("sandbox_process:p1", { id: "p1", pid: 9, status: "running" });
			const fresh = makeSb("day-fresh");
			daytona.create.mockResolvedValue(fresh);
			// day-dead is unreachable on connect; the reap reconnect also fails.
			daytona.get.mockImplementation(async (id: string) => {
				if (id === "day-dead") throw new Error("gone");
				return fresh;
			});

			const h = makeHarness({ apiKey: TEST_API_KEY }, istore);
			await sandboxPlugin.setup(h.ctx);
			await h.hooks.get("session:start")?.({} as never);

			expect((await istore.get<string>("daytona_sandbox_id"))?.value).toBe("day-fresh");
			expect(await istore.list("sandbox_process:")).toEqual([]);
		});

		it("refuses to substitute a fallback for an unreachable externally pinned sandboxId", async () => {
			const istore = makeInstanceStore();
			// The pinned id is unreachable; a stored id would be reachable — but an
			// external pin must connect ONLY the pinned id, never fall back or create.
			daytona.get.mockImplementation(async (id: string) => {
				if (id === "day-external") throw new Error("gone");
				return makeSb(id);
			});

			const h = makeHarness({ apiKey: TEST_API_KEY, sandboxId: "day-external" }, istore);
			await h.store.set("daytona_sandbox_id", "day-saved");
			await sandboxPlugin.setup(h.ctx);

			await expect(h.hooks.get("session:start")?.({} as never)).rejects.toThrow(
				"externally pinned",
			);
			expect(daytona.create).not.toHaveBeenCalled();
			// The reachable stored id must NOT have been adopted as a substitute.
			expect(daytona.get).not.toHaveBeenCalledWith("day-saved");
		});

		it("does not adopt a sandbox superseded during the reconnect window", async () => {
			const istore = makeInstanceStore();
			await istore.set("daytona_sandbox_id", "day-old");
			const oldSb = makeSb("day-old");
			const newSb = makeSb("day-new");
			daytona.get.mockImplementation(async (id: string) => {
				if (id === "day-old") {
					await istore.set("daytona_sandbox_id", "day-new");
					return oldSb;
				}
				return newSb;
			});

			const h = makeHarness({ apiKey: TEST_API_KEY }, istore);
			await sandboxPlugin.setup(h.ctx);
			await h.hooks.get("session:start")?.({} as never);

			const capability = h.provided.get(PAREL_SANDBOX_CAPABILITY) as SandboxCapability;
			expect(capability.id).toBe("day-new");
		});

		it("drops a cached handle when a sibling replaced the shared sandbox", async () => {
			const istore = makeInstanceStore();
			await istore.set("daytona_sandbox_id", "day-old");
			const oldSb = makeSb("day-old");
			const newSb = makeSb("day-new");
			newSb.fs.downloadFile.mockResolvedValue(Buffer.from("from new"));
			daytona.get.mockImplementation(async (id: string) => (id === "day-old" ? oldSb : newSb));

			const h = makeHarness({ apiKey: TEST_API_KEY }, istore);
			await sandboxPlugin.setup(h.ctx);
			await h.hooks.get("session:start")?.({} as never); // caches day-old

			await istore.set("daytona_sandbox_id", "day-new"); // sibling swaps

			const capability = h.provided.get(PAREL_SANDBOX_CAPABILITY) as SandboxCapability;
			expect(await capability.fs?.readFile("/x")).toBe("from new");
		});

		it("explicit lifecycle.stop kills the instance sandbox and clears the handle", async () => {
			const istore = makeInstanceStore();
			await istore.set("daytona_sandbox_id", "day-shared");
			const shared = makeSb("day-shared");
			daytona.get.mockResolvedValue(shared);

			const h = makeHarness({ apiKey: TEST_API_KEY }, istore);
			await sandboxPlugin.setup(h.ctx);
			await h.hooks.get("session:start")?.({} as never);
			const capability = h.provided.get(PAREL_SANDBOX_CAPABILITY) as SandboxCapability;
			await capability.lifecycle?.stop();

			expect(shared.delete).toHaveBeenCalled();
			expect(await istore.get("daytona_sandbox_id")).toBeNull();
		});

		it("skips the kill when lifecycle.stop loses the retire race", async () => {
			const istore = makeInstanceStore();
			await istore.set("daytona_sandbox_id", "day-shared");
			const shared = makeSb("day-shared");
			daytona.get.mockResolvedValue(shared);
			// Sabotage casDelete to simulate a sibling swapping mid-stop.
			istore.casDelete = async () => false;

			const h = makeHarness({ apiKey: TEST_API_KEY }, istore);
			await sandboxPlugin.setup(h.ctx);
			await h.hooks.get("session:start")?.({} as never);
			const capability = h.provided.get(PAREL_SANDBOX_CAPABILITY) as SandboxCapability;
			await capability.lifecycle?.stop();

			expect(shared.delete).not.toHaveBeenCalled();
			expect((await istore.get<string>("daytona_sandbox_id"))?.value).toBe("day-shared");
		});

		it("destroys the sandbox on session:end for an ephemeral instance", async () => {
			const istore = makeInstanceStore();
			const sb = makeSb("day-eph");
			daytona.create.mockResolvedValue(sb);
			daytona.get.mockResolvedValue(sb);

			const h = makeHarness({ apiKey: TEST_API_KEY }, istore);
			(h.ctx as { instance?: { key: string | null; ephemeral: boolean } }).instance = {
				key: null,
				ephemeral: true,
			};
			await sandboxPlugin.setup(h.ctx);
			await h.hooks.get("session:start")?.({} as never);
			await h.hooks.get("session:end")?.({} as never);

			expect(sb.delete).toHaveBeenCalled();
		});

		it("connects an externally pinned sandboxId without racing or migrating", async () => {
			const istore = makeInstanceStore();
			const pinned = makeSb("day-external");
			daytona.get.mockResolvedValue(pinned);

			const h = makeHarness({ apiKey: TEST_API_KEY, sandboxId: "day-external" }, istore);
			await sandboxPlugin.setup(h.ctx);
			await h.hooks.get("session:start")?.({} as never);

			// External pin: connect directly, do not seed the instance-store handle.
			expect(daytona.get).toHaveBeenCalledWith("day-external");
			expect(daytona.create).not.toHaveBeenCalled();
			expect(await istore.get("daytona_sandbox_id")).toBeNull();

			// SessionEnd must not kill an externally owned sandbox.
			await h.hooks.get("session:end")?.({} as never);
			expect(pinned.delete).not.toHaveBeenCalled();
		});

		it("clears shared process/port records when the sandbox is stopped", async () => {
			const istore = makeInstanceStore();
			await istore.set("daytona_sandbox_id", "day-shared");
			await istore.set("sandbox_process:p1", { id: "p1", pid: 9, status: "running" });
			await istore.set("sandbox_port:3000", { id: "3000", port: 3000 });
			daytona.get.mockResolvedValue(makeSb("day-shared"));

			const h = makeHarness({ apiKey: TEST_API_KEY }, istore);
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
			const sb = makeSb("day-shared");
			sb.process.executeCommand.mockResolvedValue({
				exitCode: 0,
				result: "4242",
				artifacts: { stdout: "4242" },
			});
			daytona.create.mockResolvedValue(sb);
			daytona.get.mockResolvedValue(sb);

			const h = makeHarness({ apiKey: TEST_API_KEY }, istore);
			await sandboxPlugin.setup(h.ctx);
			await h.hooks.get("session:start")?.({} as never);
			const processes = h.provided.get("process") as SandboxProcessView;
			await processes.start("sleep 1000");

			expect(await istore.list("sandbox_process:")).toHaveLength(1);
			expect(h.store.map.size).toBe(0);
		});
	});
});
