import { Buffer } from "node:buffer";
import { Daytona } from "@daytona/sdk";
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
import manifest from "../parel.plugin.json" with { type: "json" };

const STORE_KEY = "daytona_sandbox_id";

interface DaytonaFileSystem {
	downloadFile(path: string, timeout?: number): Promise<Buffer>;
	uploadFile(source: Buffer | string, path: string, timeout?: number): Promise<void>;
	listFiles(path: string): Promise<unknown[]>;
	getFileDetails(path: string): Promise<unknown>;
	createFolder(path: string, mode: string): Promise<void>;
	deleteFile(path: string, recursive?: boolean): Promise<void>;
	moveFiles(source: string, destination: string): Promise<void>;
}

interface DaytonaProcess {
	executeCommand(
		command: string,
		cwd?: string,
		env?: Record<string, string>,
		timeout?: number,
	): Promise<{ exitCode: number; result?: string; artifacts?: { stdout?: string } }>;
}

interface DaytonaSandbox {
	id: string;
	name?: string;
	state?: unknown;
	fs: DaytonaFileSystem;
	process: DaytonaProcess;
	getWorkDir(): Promise<string | undefined>;
	getPreviewLink(port: number): Promise<{ url: string; token?: string }>;
	start(timeout?: number): Promise<void>;
	stop(timeout?: number, force?: boolean): Promise<void>;
	delete(timeout?: number): Promise<void>;
	refreshData?(): Promise<void>;
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

function recordConfig(value: unknown): Record<string, string> | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const record: Record<string, string> = {};
	for (const [key, entry] of Object.entries(value)) {
		if (typeof entry === "string") record[key] = entry;
	}
	return Object.keys(record).length > 0 ? record : undefined;
}

function timeoutSeconds(timeoutMs?: number): number | undefined {
	return timeoutMs === undefined ? undefined : Math.ceil(timeoutMs / 1000);
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

function field(record: Record<string, unknown>, key: string): unknown {
	return record[key];
}

function mapFileType(value: unknown): SandboxFileEntry["type"] {
	const text = String(value ?? "").toLowerCase();
	if (text.includes("dir")) return "directory";
	if (text.includes("sym") || text.includes("link")) return "symlink";
	if (text.includes("file")) return "file";
	return "unknown";
}

function mapMtimeMs(value: unknown): number | undefined {
	if (typeof value === "number") return value;
	if (typeof value === "string") {
		const parsed = Date.parse(value);
		return Number.isNaN(parsed) ? undefined : parsed;
	}
	return undefined;
}

function mapFileEntry(value: unknown): SandboxFileEntry {
	const entry = (value ?? {}) as Record<string, unknown>;
	const path = stringConfig(field(entry, "path")) ?? stringConfig(field(entry, "name"));
	return {
		name: stringConfig(field(entry, "name")) ?? path ?? "",
		path,
		type: mapFileType(field(entry, "type") ?? field(entry, "fileType") ?? field(entry, "kind")),
		size: numberConfig(field(entry, "size")),
		mtimeMs: mapMtimeMs(
			field(entry, "mtimeMs") ?? field(entry, "modTime") ?? field(entry, "modifiedAt"),
		),
	};
}

function mapFileStat(path: string, value: unknown): SandboxFileStat {
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
	for (const key of ["name", "snapshot", "image", "language", "user", "networkAllowList"]) {
		const value = stringConfig(config[key]);
		if (value) params[key] = value;
	}
	for (const key of ["autoStopInterval", "autoArchiveInterval", "autoDeleteInterval"]) {
		const value = numberConfig(config[key]);
		if (value !== undefined) params[key] = value;
	}
	for (const key of ["public", "networkBlockAll", "ephemeral"]) {
		const value = booleanConfig(config[key]);
		if (value !== undefined) params[key] = value;
	}
	const envVars = recordConfig(config.envVars ?? config.env);
	if (envVars) params.envVars = envVars;
	const labels = recordConfig(config.labels);
	if (labels) params.labels = labels;
	return params;
}

export default definePlugin({
	name: "@parel/sandbox-daytona",

	provides: manifest.provides as ParelPlugin["provides"],
	requires: manifest.requires as ParelPlugin["requires"],
	execution: manifest.execution as ParelPlugin["execution"],

	async setup(ctx) {
		const apiKey = stringConfig(ctx.config.apiKey);
		const createTimeoutMs = numberConfig(ctx.config.timeoutMs);
		const createTimeout = timeoutSeconds(createTimeoutMs);
		const destroyOnSessionEnd = ctx.config.destroyOnSessionEnd !== false;
		let client: Daytona | null = null;
		let sandbox: DaytonaSandbox | null = null;
		let cwd: string | undefined;

		function getClient(): Daytona | null {
			if (!apiKey) {
				ctx.log.warn("Daytona API key not provided - skipping sandbox creation");
				return null;
			}
			client ??= new Daytona({
				apiKey,
				apiUrl: stringConfig(ctx.config.apiUrl),
				target: stringConfig(ctx.config.target),
			});
			return client;
		}

		async function rememberSandbox(next: DaytonaSandbox): Promise<void> {
			sandbox = next;
			cwd = await next.getWorkDir();
			await ctx.store.set(STORE_KEY, next.id);
		}

		async function getExisting(idOrName: string): Promise<DaytonaSandbox | null> {
			const daytona = getClient();
			if (!daytona) return null;
			try {
				const existing = (await daytona.get(idOrName)) as unknown as DaytonaSandbox;
				if (String(existing.state ?? "").toLowerCase() !== "started") {
					await existing.start(createTimeout);
				}
				await rememberSandbox(existing);
				ctx.log.info(`Daytona sandbox connected: ${existing.id}`);
				return existing;
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				ctx.log.warn(`Failed to connect Daytona sandbox ${idOrName}: ${message}`);
				return null;
			}
		}

		async function createSandbox(): Promise<DaytonaSandbox | null> {
			const daytona = getClient();
			if (!daytona) return null;
			const created = (await daytona.create(buildCreateParams(ctx.config), {
				timeout: createTimeout,
			})) as unknown as DaytonaSandbox;
			await rememberSandbox(created);
			ctx.log.info(`Daytona sandbox created: ${created.id}`);
			return created;
		}

		async function ensureSandbox(): Promise<DaytonaSandbox | null> {
			const configuredId = stringConfig(ctx.config.sandboxId);
			const configuredName = stringConfig(ctx.config.name);
			const savedId = await ctx.store.get<string>(STORE_KEY);
			for (const idOrName of [configuredId, configuredName, savedId]) {
				if (!idOrName) continue;
				const existing = await getExisting(idOrName);
				if (existing) return existing;
			}
			return createSandbox();
		}

		function requireSandbox(): DaytonaSandbox {
			if (!sandbox) throw new Error("Daytona sandbox not available");
			return sandbox;
		}

		async function disposeSandbox(): Promise<void> {
			if (!sandbox) return;
			try {
				if (destroyOnSessionEnd) {
					await sandbox.delete(createTimeout);
					await ctx.store.delete(STORE_KEY);
				} else {
					await sandbox.stop(createTimeout);
				}
			} finally {
				sandbox = null;
				cwd = undefined;
			}
		}

		async function runShell(
			command: string,
			opts?: SandboxExecOptions | SandboxShellOptions,
		): Promise<SandboxProcessResult> {
			const current = requireSandbox();
			const result = await current.process.executeCommand(
				command,
				opts?.cwd,
				opts?.env,
				timeoutSeconds(opts?.timeoutMs),
			);
			return {
				stdout: limitOutput(result.artifacts?.stdout ?? result.result ?? "", opts?.maxOutputChars),
				stderr: "",
				exitCode: result.exitCode,
				metadata: { provider: "daytona" },
			};
		}

		const capability: SandboxCapability = {
			get id() {
				return sandbox?.id;
			},
			provider: "daytona",
			get cwd() {
				return cwd;
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
					const buffer = await requireSandbox().fs.downloadFile(path, createTimeout);
					const content =
						opts?.encoding === "base64" ? buffer.toString("base64") : buffer.toString("utf8");
					return opts?.maxChars ? limitOutput(content, opts.maxChars) : content;
				},
				async writeFile(path, content, opts) {
					const buffer = Buffer.from(content, opts?.encoding === "base64" ? "base64" : "utf8");
					await requireSandbox().fs.uploadFile(buffer, path, createTimeout);
				},
				async listDir(path) {
					return (await requireSandbox().fs.listFiles(path)).map(mapFileEntry);
				},
				async stat(path) {
					return mapFileStat(path, await requireSandbox().fs.getFileDetails(path));
				},
				async exists(path) {
					try {
						await requireSandbox().fs.getFileDetails(path);
						return true;
					} catch {
						return false;
					}
				},
				async mkdir(path) {
					await requireSandbox().fs.createFolder(path, "755");
				},
				async remove(path, opts) {
					await requireSandbox().fs.deleteFile(path, opts?.recursive);
				},
				async rename(from, to) {
					await requireSandbox().fs.moveFiles(from, to);
				},
			},
			process: {
				async exec(command, opts) {
					return runShell(commandToShell(command), opts);
				},
				async shell(command, opts) {
					return runShell(command, opts);
				},
			},
			ports: {
				async expose(port) {
					const current = requireSandbox();
					const preview = await current.getPreviewLink(port);
					return { port, url: preview.url, protocol: "https", metadata: { token: preview.token } };
				},
			},
			lifecycle: {
				async isRunning() {
					if (!sandbox) return false;
					if (sandbox.refreshData) await sandbox.refreshData();
					return String(sandbox.state ?? "started").toLowerCase() === "started";
				},
				async stop() {
					await requireSandbox().stop(createTimeout);
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
			if (sandbox) await ctx.store.set(STORE_KEY, sandbox.id);
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
