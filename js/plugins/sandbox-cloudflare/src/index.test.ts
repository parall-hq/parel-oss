import { PAREL_SANDBOX_CAPABILITY, type SandboxCapability } from "@parel/capability-sandbox";
import type { HookHandler, LifecycleEvent, PluginContext } from "@parel/plugin-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";

const cloudflare = vi.hoisted(() => {
	const exec = vi.fn();
	const startProcess = vi.fn();
	const writeFile = vi.fn();
	const readFile = vi.fn();
	const mkdir = vi.fn();
	const deleteFile = vi.fn();
	const renameFile = vi.fn();
	const listFiles = vi.fn();
	const exists = vi.fn();
	const exposePort = vi.fn();
	const unexposePort = vi.fn();
	const destroy = vi.fn();
	const stop = vi.fn();
	const getStatus = vi.fn();
	const getLogs = vi.fn();
	const waitForExit = vi.fn();
	const kill = vi.fn();
	const process = {
		id: "proc-1",
		command: "sleep 1",
		status: "running",
		getStatus,
		getLogs,
		waitForExit,
		kill,
	};
	const sandbox = {
		exec,
		startProcess,
		writeFile,
		readFile,
		mkdir,
		deleteFile,
		renameFile,
		listFiles,
		exists,
		exposePort,
		unexposePort,
		destroy,
		stop,
	};
	const getSandbox = vi.fn();
	return {
		getSandbox,
		exec,
		startProcess,
		writeFile,
		readFile,
		mkdir,
		deleteFile,
		renameFile,
		listFiles,
		exists,
		exposePort,
		unexposePort,
		destroy,
		stop,
		getStatus,
		getLogs,
		waitForExit,
		kill,
		process,
		sandbox,
	};
});

vi.mock("@cloudflare/sandbox", () => ({
	getSandbox: cloudflare.getSandbox,
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
	cloudflare.getSandbox.mockReturnValue(cloudflare.sandbox);
	cloudflare.exec.mockResolvedValue({ stdout: "ok\n", stderr: "", exitCode: 0, duration: 10 });
	cloudflare.startProcess.mockResolvedValue(cloudflare.process);
	cloudflare.writeFile.mockResolvedValue({ success: true });
	cloudflare.readFile.mockResolvedValue({ content: "file", size: 4 });
	cloudflare.mkdir.mockResolvedValue({ success: true });
	cloudflare.deleteFile.mockResolvedValue({ success: true });
	cloudflare.renameFile.mockResolvedValue({ success: true });
	cloudflare.listFiles.mockResolvedValue({
		files: [
			{
				name: "a.txt",
				absolutePath: "/tmp/a.txt",
				relativePath: "a.txt",
				type: "file",
				size: 4,
				modifiedAt: "2026-01-01T00:00:00.000Z",
			},
		],
	});
	cloudflare.exists.mockResolvedValue({ exists: true });
	cloudflare.exposePort.mockResolvedValue({ port: 3000, url: "https://cf.example", name: "web" });
	cloudflare.unexposePort.mockResolvedValue(undefined);
	cloudflare.destroy.mockResolvedValue(undefined);
	cloudflare.stop.mockResolvedValue(undefined);
	cloudflare.getStatus.mockResolvedValue("running");
	cloudflare.getLogs.mockResolvedValue({ stdout: "logs\n", stderr: "" });
	cloudflare.waitForExit.mockResolvedValue({ exitCode: 0 });
	cloudflare.kill.mockResolvedValue(undefined);
});

describe("@parel/sandbox-cloudflare", () => {
	it("uses a host-injected namespace and provides parel.sandbox", async () => {
		const namespace = { binding: true };
		const h = makeHarness({ namespace, sandboxId: "agent", hostname: "preview.example.com" });
		await sandboxPlugin.setup(h.ctx);
		await h.hooks.get("session:start")?.({} as never);

		expect(cloudflare.getSandbox).toHaveBeenCalledWith(namespace, "agent", {});
		const capability = h.provided.get(PAREL_SANDBOX_CAPABILITY) as SandboxCapability;
		expect(capability.provider).toBe("cloudflare");
		expect(capability.id).toBe("agent");
	});

	it("maps exec, spawn, fs, and ports to the standard capability", async () => {
		const h = makeHarness({
			namespace: { binding: true },
			sandboxId: "agent",
			hostname: "preview.example.com",
		});
		await sandboxPlugin.setup(h.ctx);
		await h.hooks.get("session:start")?.({} as never);
		const capability = h.provided.get(PAREL_SANDBOX_CAPABILITY) as SandboxCapability;

		const result = await capability.process?.exec(["echo", "hello world"], { timeoutMs: 1000 });
		expect(cloudflare.exec).toHaveBeenCalledWith("echo 'hello world'", {
			cwd: undefined,
			env: undefined,
			timeout: 1000,
		});
		expect(result?.stdout).toBe("ok\n");

		const handle = await capability.process?.spawn?.(["sleep", "1"]);
		expect(handle?.id).toBe("proc-1");
		expect(await handle?.status()).toBe("running");
		expect(await handle?.wait()).toEqual({
			stdout: "logs\n",
			stderr: "",
			exitCode: 0,
			metadata: { provider: "cloudflare", processId: "proc-1" },
		});

		expect(await capability.fs?.readFile("/tmp/a.txt")).toBe("file");
		await capability.fs?.writeFile("/tmp/a.txt", "next");
		expect(cloudflare.writeFile).toHaveBeenCalledWith("/tmp/a.txt", "next", { encoding: "utf8" });
		expect(await capability.fs?.listDir("/tmp")).toMatchObject([{ name: "a.txt", type: "file" }]);
		expect(await capability.ports?.expose(3000, { label: "web" })).toEqual({
			port: 3000,
			url: "https://cf.example",
			protocol: "https",
			metadata: { name: "web" },
		});
	});

	it("does not destroy the host-managed sandbox by default", async () => {
		const h = makeHarness({ namespace: {}, sandboxId: "agent" });
		await sandboxPlugin.setup(h.ctx);
		await h.hooks.get("session:start")?.({} as never);
		await h.hooks.get("session:end")?.({} as never);
		expect(cloudflare.destroy).not.toHaveBeenCalled();
	});
});
