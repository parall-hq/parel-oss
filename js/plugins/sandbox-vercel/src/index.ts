import { Buffer } from "node:buffer";
import {
	createSandboxCapabilityViews,
	PAREL_SANDBOX_CAPABILITY,
	type SandboxCapability,
	type SandboxCommand,
	type SandboxExecOptions,
	type SandboxFileStat,
	type SandboxFileType,
	type SandboxProcessHandle,
	type SandboxProcessResult,
	type SandboxProcessStatus,
	type SandboxShellOptions,
	type SandboxSpawnOptions,
} from "@parel/capability-sandbox";
import { definePlugin, LifecycleEvent, type ParelPlugin } from "@parel/plugin-sdk";
import { Sandbox as VercelSandboxClient } from "@vercel/sandbox";
import manifest from "../parel.plugin.json" with { type: "json" };

const STORE_KEY = "vercel_sandbox_name";

interface VercelCommand {
	cmdId: string;
	exitCode: number | null;
	wait(opts?: { signal?: AbortSignal }): Promise<VercelCommandFinished>;
	kill(signal?: string): Promise<void>;
	stdout(): Promise<string>;
	stderr(): Promise<string>;
}

interface VercelCommandFinished extends VercelCommand {
	exitCode: number;
}

interface VercelStats {
	size?: number;
	mtimeMs?: number;
	mode?: number;
	isFile?(): boolean;
	isDirectory?(): boolean;
	isSymbolicLink?(): boolean;
}

interface VercelDirent {
	name: string;
	isFile?(): boolean;
	isDirectory?(): boolean;
	isSymbolicLink?(): boolean;
}

interface VercelFs {
	readFile(path: string, opts?: { encoding?: BufferEncoding | null }): Promise<string | Buffer>;
	writeFile(path: string, data: string | Buffer | Uint8Array): Promise<void>;
	appendFile?(path: string, data: string | Buffer | Uint8Array): Promise<void>;
	readdir(path: string, opts: { withFileTypes: true }): Promise<VercelDirent[]>;
	stat(path: string): Promise<VercelStats>;
	exists(path: string): Promise<boolean>;
	mkdir(path: string, opts?: { recursive?: boolean }): Promise<string | undefined>;
	rm(path: string, opts?: { recursive?: boolean; force?: boolean }): Promise<void>;
	rename(from: string, to: string): Promise<void>;
}

interface VercelSandbox {
	name: string;
	status?: string;
	runtime?: string;
	timeout?: number;
	fs: VercelFs;
	runCommand(params: Record<string, unknown>): Promise<VercelCommand | VercelCommandFinished>;
	domain(port: number): string;
	stop(): Promise<unknown>;
	delete(): Promise<void>;
	extendTimeout?(timeoutMs: number): Promise<void>;
}

function stringConfig(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberConfig(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
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

function mapStatsType(stats: VercelStats): SandboxFileType {
	if (stats.isDirectory?.()) return "directory";
	if (stats.isSymbolicLink?.()) return "symlink";
	if (stats.isFile?.()) return "file";
	return "unknown";
}

function mapDirentType(dirent: VercelDirent): SandboxFileType {
	if (dirent.isDirectory?.()) return "directory";
	if (dirent.isSymbolicLink?.()) return "symlink";
	if (dirent.isFile?.()) return "file";
	return "unknown";
}

function mapCommandStatus(command: VercelCommand): SandboxProcessStatus {
	if (command.exitCode === null) return "running";
	return command.exitCode === 0 ? "exited" : "failed";
}

async function commandResult(
	command: VercelCommandFinished,
	opts?: SandboxExecOptions | SandboxShellOptions | SandboxSpawnOptions,
): Promise<SandboxProcessResult> {
	return {
		stdout: limitOutput(await command.stdout(), opts?.maxOutputChars),
		stderr: limitOutput(await command.stderr(), opts?.maxOutputChars),
		exitCode: command.exitCode,
		metadata: { provider: "vercel", commandId: command.cmdId },
	};
}

function runParams(command: SandboxCommand, opts?: SandboxExecOptions | SandboxSpawnOptions) {
	return {
		cmd: command[0],
		args: [...command.slice(1)],
		cwd: opts?.cwd,
		env: opts?.env,
		timeoutMs: opts?.timeoutMs,
	};
}

function buildCreateParams(config: Record<string, unknown>): Record<string, unknown> {
	const params: Record<string, unknown> = {};
	for (const key of ["name", "runtime"]) {
		const value = stringConfig(config[key]);
		if (value) params[key] = value;
	}
	const timeout = numberConfig(config.timeoutMs);
	if (timeout !== undefined) params.timeout = timeout;
	const ports = numberArray(config.ports);
	if (ports) params.ports = ports;
	const env = stringRecord(config.env);
	if (env) params.env = env;
	const tags = stringRecord(config.tags);
	if (tags) params.tags = tags;
	return params;
}

export default definePlugin({
	name: "@parel/sandbox-vercel",

	provides: manifest.provides as ParelPlugin["provides"],
	requires: manifest.requires as ParelPlugin["requires"],
	execution: manifest.execution as ParelPlugin["execution"],

	async setup(ctx) {
		const token = stringConfig(ctx.config.token);
		const teamId = stringConfig(ctx.config.teamId);
		const projectId = stringConfig(ctx.config.projectId);
		const destroyOnSessionEnd = ctx.config.destroyOnSessionEnd !== false;
		let sandbox: VercelSandbox | null = null;

		function credentials(): Record<string, string> | null {
			if (!token || !teamId || !projectId) {
				ctx.log.warn("Vercel Sandbox token, teamId, and projectId are required");
				return null;
			}
			return { token, teamId, projectId };
		}

		function requireSandbox(): VercelSandbox {
			if (!sandbox) throw new Error("Vercel sandbox not available");
			return sandbox;
		}

		async function ensureSandbox(): Promise<VercelSandbox | null> {
			const creds = credentials();
			if (!creds) return null;
			const savedName = await ctx.store.get<string>(STORE_KEY);
			const name = stringConfig(ctx.config.name) ?? savedName;
			const params = { ...buildCreateParams(ctx.config), ...creds };
			if (name) {
				sandbox = (await VercelSandboxClient.getOrCreate({
					...params,
					name,
				})) as unknown as VercelSandbox;
			} else {
				sandbox = (await VercelSandboxClient.create(params)) as unknown as VercelSandbox;
			}
			await ctx.store.set(STORE_KEY, sandbox.name);
			ctx.log.info(`Vercel sandbox ready: ${sandbox.name}`);
			return sandbox;
		}

		async function disposeSandbox(): Promise<void> {
			if (!sandbox) return;
			try {
				if (destroyOnSessionEnd) {
					await sandbox.delete();
					await ctx.store.delete(STORE_KEY);
				} else {
					await sandbox.stop();
				}
			} finally {
				sandbox = null;
			}
		}

		async function execCommand(
			command: SandboxCommand,
			opts?: SandboxExecOptions,
		): Promise<SandboxProcessResult> {
			const finished = (await requireSandbox().runCommand(
				runParams(command, opts),
			)) as VercelCommandFinished;
			return commandResult(finished, opts);
		}

		async function shellCommand(
			command: string,
			opts?: SandboxShellOptions,
		): Promise<SandboxProcessResult> {
			const shell = opts?.shell ?? "sh";
			const finished = (await requireSandbox().runCommand({
				cmd: shell,
				args: ["-lc", command],
				cwd: opts?.cwd,
				env: opts?.env,
				timeoutMs: opts?.timeoutMs,
			})) as VercelCommandFinished;
			return commandResult(finished, opts);
		}

		function processHandle(command: VercelCommand, original: SandboxCommand): SandboxProcessHandle {
			return {
				id: command.cmdId,
				command: original,
				async status() {
					return mapCommandStatus(command);
				},
				async wait(opts) {
					const finished = await command.wait(opts ? { signal: undefined } : undefined);
					return commandResult(finished, opts);
				},
				async kill(signal) {
					await command.kill(signal);
				},
				async stdout(opts) {
					return limitOutput(await command.stdout(), opts?.maxChars);
				},
				async stderr(opts) {
					return limitOutput(await command.stderr(), opts?.maxChars);
				},
			};
		}

		const capability: SandboxCapability = {
			get id() {
				return sandbox?.name;
			},
			provider: "vercel",
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
					const content = await requireSandbox().fs.readFile(path, {
						encoding: opts?.encoding === "base64" ? null : "utf8",
					});
					const text = Buffer.isBuffer(content) ? content.toString("base64") : content;
					return opts?.maxChars ? limitOutput(text, opts.maxChars) : text;
				},
				async writeFile(path, content, opts) {
					const data = opts?.encoding === "base64" ? Buffer.from(content, "base64") : content;
					if (opts?.append && requireSandbox().fs.appendFile) {
						await requireSandbox().fs.appendFile?.(path, data);
					} else {
						await requireSandbox().fs.writeFile(path, data);
					}
				},
				async listDir(path) {
					return (await requireSandbox().fs.readdir(path, { withFileTypes: true })).map(
						(entry) => ({
							name: entry.name,
							type: mapDirentType(entry),
						}),
					);
				},
				async stat(path) {
					const stats = await requireSandbox().fs.stat(path);
					return {
						path,
						type: mapStatsType(stats),
						size: stats.size,
						mtimeMs: stats.mtimeMs,
						mode: stats.mode,
					} satisfies SandboxFileStat;
				},
				async exists(path) {
					return requireSandbox().fs.exists(path);
				},
				async mkdir(path, opts) {
					await requireSandbox().fs.mkdir(path, { recursive: opts?.recursive });
				},
				async remove(path, opts) {
					await requireSandbox().fs.rm(path, { recursive: opts?.recursive, force: true });
				},
				async rename(from, to) {
					await requireSandbox().fs.rename(from, to);
				},
			},
			process: {
				exec: execCommand,
				shell: shellCommand,
				async spawn(command, opts) {
					const handle = (await requireSandbox().runCommand({
						...runParams(command, opts),
						detached: true,
					})) as VercelCommand;
					return processHandle(handle, command);
				},
			},
			ports: {
				async expose(port) {
					return { port, url: requireSandbox().domain(port), protocol: "https" };
				},
			},
			lifecycle: {
				async isRunning() {
					return String(sandbox?.status ?? "running") === "running";
				},
				async stop() {
					await requireSandbox().stop();
				},
				async extendTimeout(timeoutMs) {
					await requireSandbox().extendTimeout?.(timeoutMs);
				},
			},
		};

		ctx.hook(LifecycleEvent.SessionStart, async () => {
			await ensureSandbox();
		});

		ctx.hook(LifecycleEvent.SessionResume, async () => {
			await ensureSandbox();
		});

		ctx.hook(LifecycleEvent.SessionSuspend, async () => {
			if (sandbox) await ctx.store.set(STORE_KEY, sandbox.name);
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
