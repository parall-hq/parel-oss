import { PAREL_SANDBOX_CAPABILITY, type SandboxCapability } from "@parel/capability-sandbox";
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
		async list() {
			return [...map.keys()];
		},
	};
}

function makeHarness(config: Record<string, unknown>) {
	const hooks = new Map<string, HookHandler<LifecycleEvent>>();
	const provided = new Map<string, unknown>();
	const ctx = {
		config,
		store: makeStore(),
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
	return { ctx, hooks, provided };
}

beforeEach(() => {
	vi.clearAllMocks();
	vercel.create.mockResolvedValue(vercel.sandbox);
	vercel.getOrCreate.mockResolvedValue(vercel.sandbox);
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
});
