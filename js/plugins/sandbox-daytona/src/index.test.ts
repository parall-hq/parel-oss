import { PAREL_SANDBOX_CAPABILITY, type SandboxCapability } from "@parel/capability-sandbox";
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
});
