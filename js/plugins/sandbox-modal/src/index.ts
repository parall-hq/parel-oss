import { Buffer } from "node:buffer";
import {
	createSandboxCapabilityViews,
	PAREL_SANDBOX_CAPABILITY,
	type SandboxCapability,
	type SandboxCommand,
	type SandboxExecOptions,
	type SandboxFileEntry,
	type SandboxFileStat,
	type SandboxProcessResult,
	type SandboxShellOptions,
} from "@parel/capability-sandbox";
import { definePlugin, LifecycleEvent, type ParelPlugin } from "@parel/plugin-sdk";
import { Image, ModalClient } from "modal";
import manifest from "../parel.plugin.json" with { type: "json" };

const STORE_KEY = "modal_sandbox_id";

interface ModalReadStream {
	readText(): Promise<string>;
	readBytes(): Promise<Uint8Array>;
}

interface ModalProcess {
	stdout: ModalReadStream;
	stderr: ModalReadStream;
	wait(): Promise<number>;
}

interface ModalFileInfo {
	name?: string;
	path?: string;
	type?: string;
	size?: number;
	mtimeMs?: number;
	modifiedTime?: number;
}

interface ModalFilesystem {
	readText(path: string): Promise<string>;
	readBytes(path: string): Promise<Uint8Array>;
	writeText(content: string, path: string): Promise<void>;
	writeBytes(content: Uint8Array | ArrayBuffer | Buffer, path: string): Promise<void>;
	listFiles(path: string): Promise<ModalFileInfo[]>;
	stat(path: string): Promise<ModalFileInfo>;
	makeDirectory(path: string, opts?: { createParents?: boolean }): Promise<void>;
	remove(path: string, opts?: { recursive?: boolean }): Promise<void>;
}

interface ModalTunnel {
	url: string;
	tlsSocket?: [string, number];
	tcpSocket?: [string, number];
}

interface ModalSandbox {
	sandboxId: string;
	filesystem: ModalFilesystem;
	exec(command: string[], params?: Record<string, unknown>): Promise<ModalProcess>;
	tunnels(timeoutMs?: number): Promise<Record<number, ModalTunnel>>;
	terminate(): Promise<void>;
	terminate(params: { wait: true }): Promise<number>;
	detach(): void;
}

function stringConfig(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberConfig(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function booleanConfig(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

function stringRecord(value: unknown): Record<string, string> | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const record: Record<string, string> = {};
	for (const [key, entry] of Object.entries(value)) {
		if (typeof entry === "string") record[key] = entry;
	}
	return Object.keys(record).length > 0 ? record : undefined;
}

function numberArray(value: unknown): number[] | undefined {
	return Array.isArray(value)
		? value.filter((entry): entry is number => typeof entry === "number")
		: undefined;
}

function limitOutput(value: string, maxOutputChars?: number): string {
	if (!maxOutputChars || value.length <= maxOutputChars) return value;
	return value.slice(0, maxOutputChars);
}

function mapFileType(value: unknown): SandboxFileEntry["type"] {
	const text = String(value ?? "").toLowerCase();
	if (text.includes("dir")) return "directory";
	if (text.includes("sym") || text.includes("link")) return "symlink";
	if (text.includes("file")) return "file";
	return "unknown";
}

function mapFileEntry(value: ModalFileInfo): SandboxFileEntry {
	return {
		name: value.name ?? value.path ?? "",
		path: value.path,
		type: mapFileType(value.type),
		size: value.size,
		mtimeMs: value.mtimeMs ?? value.modifiedTime,
	};
}

function mapFileStat(path: string, value: ModalFileInfo): SandboxFileStat {
	const entry = mapFileEntry(value);
	return {
		path: entry.path ?? path,
		type: entry.type ?? "unknown",
		size: entry.size,
		mtimeMs: entry.mtimeMs,
	};
}

function buildCreateParams(config: Record<string, unknown>): Record<string, unknown> {
	const params: Record<string, unknown> = {};
	for (const key of ["name", "workdir", "gpu", "cloud"]) {
		const value = stringConfig(config[key]);
		if (value) params[key] = value;
	}
	for (const key of [
		"timeoutMs",
		"idleTimeoutMs",
		"cpu",
		"cpuLimit",
		"memoryMiB",
		"memoryLimitMiB",
	]) {
		const value = numberConfig(config[key]);
		if (value !== undefined) params[key] = value;
	}
	for (const key of ["blockNetwork", "verbose"]) {
		const value = booleanConfig(config[key]);
		if (value !== undefined) params[key] = value;
	}
	const env = stringRecord(config.env);
	if (env) params.env = env;
	const tags = stringRecord(config.tags);
	if (tags) params.tags = tags;
	const ports = numberArray(config.ports);
	if (ports) params.encryptedPorts = ports;
	return params;
}

async function processResult(
	process: ModalProcess,
	opts?: SandboxExecOptions | SandboxShellOptions,
): Promise<SandboxProcessResult> {
	const [exitCode, stdout, stderr] = await Promise.all([
		process.wait(),
		process.stdout.readText(),
		process.stderr.readText(),
	]);
	return {
		stdout: limitOutput(stdout, opts?.maxOutputChars),
		stderr: limitOutput(stderr, opts?.maxOutputChars),
		exitCode,
		metadata: { provider: "modal" },
	};
}

export default definePlugin({
	name: "@parel/sandbox-modal",

	provides: manifest.provides as ParelPlugin["provides"],
	requires: manifest.requires as ParelPlugin["requires"],
	execution: manifest.execution as ParelPlugin["execution"],

	async setup(ctx) {
		const tokenId = stringConfig(ctx.config.tokenId);
		const tokenSecret = stringConfig(ctx.config.tokenSecret);
		const environment = stringConfig(ctx.config.environment);
		const appName = stringConfig(ctx.config.appName) ?? "parel-agent";
		const imageRef = stringConfig(ctx.config.image) ?? "python:3.13";
		const destroyOnSessionEnd = ctx.config.destroyOnSessionEnd !== false;
		let client: ModalClient | null = null;
		let sandbox: ModalSandbox | null = null;

		function getClient(): ModalClient | null {
			if (!tokenId || !tokenSecret) {
				ctx.log.warn("Modal tokenId and tokenSecret are required");
				return null;
			}
			client ??= new ModalClient({ tokenId, tokenSecret, environment });
			return client;
		}

		function requireSandbox(): ModalSandbox {
			if (!sandbox) throw new Error("Modal sandbox not available");
			return sandbox;
		}

		async function connectOrCreate(): Promise<ModalSandbox | null> {
			const modal = getClient();
			if (!modal) return null;
			const sandboxId =
				stringConfig(ctx.config.sandboxId) ?? (await ctx.store.get<string>(STORE_KEY));
			if (sandboxId) {
				sandbox = (await modal.sandboxes.fromId(sandboxId)) as ModalSandbox;
			} else if (stringConfig(ctx.config.name)) {
				try {
					sandbox = (await modal.sandboxes.fromName(appName, stringConfig(ctx.config.name) ?? "", {
						environment,
					})) as ModalSandbox;
				} catch {
					const app = await modal.apps.fromName(appName, { createIfMissing: true, environment });
					const image = Image.fromRegistry(imageRef);
					sandbox = (await modal.sandboxes.create(
						app,
						image,
						buildCreateParams(ctx.config),
					)) as ModalSandbox;
				}
			} else {
				const app = await modal.apps.fromName(appName, { createIfMissing: true, environment });
				const image = Image.fromRegistry(imageRef);
				sandbox = (await modal.sandboxes.create(
					app,
					image,
					buildCreateParams(ctx.config),
				)) as ModalSandbox;
			}
			await ctx.store.set(STORE_KEY, sandbox.sandboxId);
			ctx.log.info(`Modal sandbox ready: ${sandbox.sandboxId}`);
			return sandbox;
		}

		async function disposeSandbox(): Promise<void> {
			if (!sandbox) return;
			try {
				if (destroyOnSessionEnd) {
					await sandbox.terminate();
					await ctx.store.delete(STORE_KEY);
				} else {
					sandbox.detach();
				}
			} finally {
				sandbox = null;
			}
		}

		async function execCommand(
			command: SandboxCommand,
			opts?: SandboxExecOptions,
		): Promise<SandboxProcessResult> {
			const process = await requireSandbox().exec([...command], {
				mode: "text",
				workdir: opts?.cwd,
				timeoutMs: opts?.timeoutMs,
				env: opts?.env,
			});
			return processResult(process, opts);
		}

		async function shellCommand(
			command: string,
			opts?: SandboxShellOptions,
		): Promise<SandboxProcessResult> {
			const shell = opts?.shell ?? "sh";
			const process = await requireSandbox().exec([shell, "-lc", command], {
				mode: "text",
				workdir: opts?.cwd,
				timeoutMs: opts?.timeoutMs,
				env: opts?.env,
			});
			return processResult(process, opts);
		}

		const capability: SandboxCapability = {
			get id() {
				return sandbox?.sandboxId;
			},
			provider: "modal",
			get cwd() {
				return stringConfig(ctx.config.workdir);
			},
			supports: {
				fs: true,
				process: true,
				shell: true,
				spawn: false,
				ports: true,
				lifecycle: true,
				network: "enabled",
			},
			fs: {
				async readFile(path, opts) {
					if (opts?.encoding === "base64") {
						return Buffer.from(await requireSandbox().filesystem.readBytes(path)).toString(
							"base64",
						);
					}
					const content = await requireSandbox().filesystem.readText(path);
					return opts?.maxChars ? limitOutput(content, opts.maxChars) : content;
				},
				async writeFile(path, content, opts) {
					if (opts?.encoding === "base64") {
						await requireSandbox().filesystem.writeBytes(Buffer.from(content, "base64"), path);
					} else {
						await requireSandbox().filesystem.writeText(content, path);
					}
				},
				async listDir(path) {
					return (await requireSandbox().filesystem.listFiles(path)).map(mapFileEntry);
				},
				async stat(path) {
					return mapFileStat(path, await requireSandbox().filesystem.stat(path));
				},
				async exists(path) {
					try {
						await requireSandbox().filesystem.stat(path);
						return true;
					} catch {
						return false;
					}
				},
				async mkdir(path, opts) {
					await requireSandbox().filesystem.makeDirectory(path, {
						createParents: opts?.recursive ?? true,
					});
				},
				async remove(path, opts) {
					await requireSandbox().filesystem.remove(path, { recursive: opts?.recursive });
				},
			},
			process: {
				exec: execCommand,
				shell: shellCommand,
			},
			ports: {
				async expose(port) {
					const tunnels = await requireSandbox().tunnels(numberConfig(ctx.config.tunnelTimeoutMs));
					const tunnel = tunnels[port];
					if (!tunnel) throw new Error(`Modal tunnel for port ${port} is not available`);
					return { port, url: tunnel.url, protocol: "https" };
				},
			},
			lifecycle: {
				async isRunning() {
					return sandbox !== null;
				},
				async stop() {
					await requireSandbox().terminate();
				},
			},
		};

		ctx.hook(LifecycleEvent.SessionStart, async () => {
			await connectOrCreate();
		});

		ctx.hook(LifecycleEvent.SessionResume, async () => {
			await connectOrCreate();
		});

		ctx.hook(LifecycleEvent.SessionSuspend, async () => {
			if (sandbox) await ctx.store.set(STORE_KEY, sandbox.sandboxId);
		});

		ctx.hook(LifecycleEvent.SessionEnd, async () => {
			await disposeSandbox();
		});

		ctx.provide(PAREL_SANDBOX_CAPABILITY, capability);
		const views = createSandboxCapabilityViews(capability, ctx.store);
		ctx.provide("filesystem", views.filesystem);
		ctx.provide("exec", views.exec);
		ctx.provide("process", views.process);
		ctx.provide("ports", views.ports);
	},
});
