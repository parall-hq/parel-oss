import { basename, dirname } from "node:path/posix";
import { getSandbox } from "@cloudflare/sandbox";
import {
	createSandboxCapabilityViews,
	PAREL_SANDBOX_CAPABILITY,
	type SandboxCapability,
	type SandboxCommand,
	type SandboxExecOptions,
	type SandboxFileEntry,
	type SandboxFileStat,
	type SandboxProcessHandle,
	type SandboxProcessResult,
	type SandboxProcessStatus,
	type SandboxShellOptions,
	type SandboxSpawnOptions,
} from "@parel/capability-sandbox";
import { definePlugin, LifecycleEvent, type ParelPlugin } from "@parel/plugin-sdk";
import manifest from "../parel.plugin.json" with { type: "json" };

const DEFAULT_SANDBOX_ID = "parel-default";
const STORE_KEY = "cloudflare_sandbox_id";

interface CloudflareExecResult {
	stdout: string;
	stderr: string;
	exitCode: number;
	duration?: number;
	timestamp?: string;
}

interface CloudflareFileInfo {
	name: string;
	absolutePath: string;
	relativePath: string;
	type: "file" | "directory" | "symlink" | "other";
	size: number;
	modifiedAt: string;
	mode?: string;
}

interface CloudflareProcess {
	id: string;
	command: string;
	status: string;
	exitCode?: number;
	kill(signal?: string): Promise<void>;
	getStatus(): Promise<string>;
	getLogs(): Promise<{ stdout: string; stderr: string }>;
	waitForExit(timeout?: number): Promise<{ exitCode: number }>;
}

interface CloudflareSandbox {
	exec(command: string, opts?: Record<string, unknown>): Promise<CloudflareExecResult>;
	startProcess(command: string, opts?: Record<string, unknown>): Promise<CloudflareProcess>;
	writeFile(path: string, content: string, opts?: Record<string, unknown>): Promise<unknown>;
	readFile(
		path: string,
		opts?: Record<string, unknown>,
	): Promise<{ content: string; size?: number }>;
	mkdir(path: string, opts?: { recursive?: boolean }): Promise<unknown>;
	deleteFile(path: string): Promise<unknown>;
	renameFile(from: string, to: string): Promise<unknown>;
	listFiles(path: string, opts?: Record<string, unknown>): Promise<{ files: CloudflareFileInfo[] }>;
	exists(path: string): Promise<{ exists: boolean }>;
	exposePort(
		port: number,
		opts: { hostname: string; name?: string; token?: string },
	): Promise<{ url: string; port: number; name?: string }>;
	unexposePort(port: number): Promise<void>;
	destroy?(): Promise<void>;
	stop?(): Promise<void>;
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

function quoteShellArg(arg: string): string {
	if (/^[A-Za-z0-9_./:=@%+-]+$/.test(arg)) return arg;
	return `'${arg.replaceAll("'", "'\\''")}'`;
}

function commandToShell(command: SandboxCommand): string {
	return command.map(quoteShellArg).join(" ");
}

function limitOutput(value: string, maxOutputChars?: number): string {
	if (!maxOutputChars || value.length <= maxOutputChars) return value;
	return value.slice(0, maxOutputChars);
}

function mapProcessStatus(status: string): SandboxProcessStatus {
	if (status === "completed") return "exited";
	if (status === "failed" || status === "error") return "failed";
	if (status === "killed") return "killed";
	if (status === "running" || status === "starting") return "running";
	return "unknown";
}

function mapFileType(value: CloudflareFileInfo["type"]): SandboxFileEntry["type"] {
	if (value === "directory") return "directory";
	if (value === "symlink") return "symlink";
	if (value === "file") return "file";
	return "unknown";
}

function mapFileInfo(value: CloudflareFileInfo): SandboxFileEntry {
	const parsed = Date.parse(value.modifiedAt);
	return {
		name: value.name,
		path: value.absolutePath,
		type: mapFileType(value.type),
		size: value.size,
		mtimeMs: Number.isNaN(parsed) ? undefined : parsed,
	};
}

function mapFileStat(path: string, value: CloudflareFileInfo): SandboxFileStat {
	const entry = mapFileInfo(value);
	return {
		path: entry.path ?? path,
		type: entry.type ?? "unknown",
		size: entry.size,
		mtimeMs: entry.mtimeMs,
	};
}

function buildOptions(config: Record<string, unknown>): Record<string, unknown> {
	const options: Record<string, unknown> = {};
	const sleepAfter = stringConfig(config.sleepAfter) ?? numberConfig(config.sleepAfter);
	if (sleepAfter !== undefined) options.sleepAfter = sleepAfter;
	for (const key of ["keepAlive", "enableDefaultSession", "normalizeId"]) {
		const value = booleanConfig(config[key]);
		if (value !== undefined) options[key] = value;
	}
	const transport = stringConfig(config.transport);
	if (transport) options.transport = transport;
	return options;
}

function execOptions(opts?: SandboxExecOptions | SandboxShellOptions | SandboxSpawnOptions) {
	return {
		cwd: opts?.cwd,
		env: opts?.env,
		timeout: opts?.timeoutMs,
	};
}

export default definePlugin({
	name: "@parel/sandbox-cloudflare",

	provides: manifest.provides as ParelPlugin["provides"],
	requires: manifest.requires as ParelPlugin["requires"],
	execution: manifest.execution as ParelPlugin["execution"],

	async setup(ctx) {
		const sandboxId = stringConfig(ctx.config.sandboxId) ?? DEFAULT_SANDBOX_ID;
		const destroyOnSessionEnd = ctx.config.destroyOnSessionEnd === true;
		let sandbox: CloudflareSandbox | null = null;

		function ensureSandbox(): CloudflareSandbox | null {
			if (sandbox) return sandbox;
			const namespace = ctx.config.namespace;
			if (!namespace) {
				ctx.log.warn("Cloudflare Sandbox namespace is required and must be host-injected");
				return null;
			}
			sandbox = getSandbox(
				namespace as never,
				sandboxId,
				buildOptions(ctx.config),
			) as CloudflareSandbox;
			return sandbox;
		}

		function requireSandbox(): CloudflareSandbox {
			const current = ensureSandbox();
			if (!current) throw new Error("Cloudflare sandbox not available");
			return current;
		}

		async function execShell(
			command: string,
			opts?: SandboxExecOptions | SandboxShellOptions,
		): Promise<SandboxProcessResult> {
			const result = await requireSandbox().exec(command, execOptions(opts));
			return {
				stdout: limitOutput(result.stdout, opts?.maxOutputChars),
				stderr: limitOutput(result.stderr, opts?.maxOutputChars),
				exitCode: result.exitCode,
				metadata: {
					provider: "cloudflare",
					duration: result.duration,
					timestamp: result.timestamp,
				},
			};
		}

		function processHandle(
			process: CloudflareProcess,
			command: SandboxCommand,
		): SandboxProcessHandle {
			return {
				id: process.id,
				command,
				async status() {
					return mapProcessStatus(await process.getStatus());
				},
				async wait(opts) {
					const [{ exitCode }, logs] = await Promise.all([
						process.waitForExit(opts?.timeoutMs),
						process.getLogs(),
					]);
					return {
						stdout: logs.stdout,
						stderr: logs.stderr,
						exitCode,
						metadata: { provider: "cloudflare", processId: process.id },
					};
				},
				async kill(signal) {
					await process.kill(signal);
				},
				async stdout(opts) {
					return limitOutput((await process.getLogs()).stdout, opts?.maxChars);
				},
				async stderr(opts) {
					return limitOutput((await process.getLogs()).stderr, opts?.maxChars);
				},
			};
		}

		const capability: SandboxCapability = {
			id: sandboxId,
			provider: "cloudflare",
			supports: {
				fs: true,
				process: true,
				shell: true,
				spawn: true,
				ports: true,
				lifecycle: true,
				network: "enabled",
			},
			fs: {
				async readFile(path, opts) {
					const result = await requireSandbox().readFile(path, {
						encoding: opts?.encoding === "base64" ? "base64" : "utf8",
					});
					return opts?.maxChars ? limitOutput(result.content, opts.maxChars) : result.content;
				},
				async writeFile(path, content, opts) {
					await requireSandbox().writeFile(path, content, {
						encoding: opts?.encoding === "base64" ? "base64" : "utf8",
					});
				},
				async listDir(path) {
					return (await requireSandbox().listFiles(path)).files.map(mapFileInfo);
				},
				async stat(path) {
					const parent = dirname(path);
					const name = basename(path);
					const result = await requireSandbox().listFiles(parent);
					const info = result.files.find(
						(entry) => entry.name === name || entry.absolutePath === path,
					);
					if (!info) throw new Error(`Cloudflare sandbox path not found: ${path}`);
					return mapFileStat(path, info);
				},
				async exists(path) {
					return (await requireSandbox().exists(path)).exists;
				},
				async mkdir(path, opts) {
					await requireSandbox().mkdir(path, { recursive: opts?.recursive });
				},
				async remove(path) {
					await requireSandbox().deleteFile(path);
				},
				async rename(from, to) {
					await requireSandbox().renameFile(from, to);
				},
			},
			process: {
				async exec(command, opts) {
					return execShell(commandToShell(command), opts);
				},
				async shell(command, opts) {
					return execShell(command, opts);
				},
				async spawn(command, opts) {
					const process = await requireSandbox().startProcess(commandToShell(command), {
						...execOptions(opts),
						processId: opts?.name,
					});
					return processHandle(process, command);
				},
			},
			ports: {
				async expose(port, opts) {
					const hostname = stringConfig(ctx.config.hostname);
					if (!hostname) throw new Error("Cloudflare sandbox hostname is required to expose ports");
					const result = await requireSandbox().exposePort(port, { hostname, name: opts?.label });
					return {
						port: result.port,
						url: result.url,
						protocol: "https",
						metadata: { name: result.name },
					};
				},
				async unexpose(port) {
					await requireSandbox().unexposePort(port);
				},
			},
			lifecycle: {
				async isRunning() {
					return ensureSandbox() !== null;
				},
				async stop() {
					await requireSandbox().stop?.();
				},
			},
		};

		ctx.hook(LifecycleEvent.SessionStart, async () => {
			if (ensureSandbox()) await ctx.store.set(STORE_KEY, sandboxId);
		});

		ctx.hook(LifecycleEvent.SessionResume, async () => {
			if (ensureSandbox()) await ctx.store.set(STORE_KEY, sandboxId);
		});

		ctx.hook(LifecycleEvent.SessionEnd, async () => {
			if (!sandbox) return;
			if (destroyOnSessionEnd) await sandbox.destroy?.();
			sandbox = null;
		});

		ctx.provide(PAREL_SANDBOX_CAPABILITY, capability);
		const views = createSandboxCapabilityViews(capability, ctx.store);
		ctx.provide("filesystem", views.filesystem);
		ctx.provide("exec", views.exec);
		ctx.provide("process", views.process);
		ctx.provide("ports", views.ports);
	},
});
