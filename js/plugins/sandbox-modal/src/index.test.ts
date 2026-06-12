import { PAREL_SANDBOX_CAPABILITY, type SandboxCapability } from "@parel/capability-sandbox";
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
});
