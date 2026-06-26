import { Sandbox } from "@e2b/code-interpreter";
import {
	PAREL_SANDBOX_CAPABILITY,
	type SandboxCapability,
	type SandboxCommand,
	type SandboxExecOptions,
	type SandboxProcessResult,
	type SandboxShellOptions,
} from "@parel/capability-sandbox";
import {
	definePlugin,
	type InvocationContext,
	LifecycleEvent,
	type ParelPlugin,
} from "@parel/plugin-sdk";
// Single source of truth for this plugin's static manifest (the secrets it needs).
// Shipped at the package root (see package.json `files`) so the host can read it from
// a CDN (jsDelivr) at deploy time — without loading the plugin — to drive credential
// UIs. Imported here so the same declaration also drives runtime validation.
import manifest from "../parel.plugin.json" with { type: "json" };

const STORE_KEY = "e2b_sandbox_id";
const PROCESS_STORE_PREFIX = "e2b_process:";
const PORT_STORE_PREFIX = "e2b_port:";

/**
 * Flatten a per-turn invocation context into string env vars for a single command
 * execution. The platform only delivers structured context; turning it into env
 * (string-only) is this plugin's job. Non-string values are JSON-stringified; an
 * explicit `null` is a clear (empty string), so every key the turn provides overrides
 * the cold-start `config.env` rather than falling back to its static value.
 * Design: docs/invocation-context.md §6.
 */
function invocationEnv(invocation?: InvocationContext): Record<string, string> | undefined {
	if (!invocation) return undefined;
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(invocation.context)) {
		if (value === undefined) continue; // absent key → inherit cold-start env
		env[key] = value === null ? "" : typeof value === "string" ? value : JSON.stringify(value);
	}
	return Object.keys(env).length > 0 ? env : undefined;
}

type ProcessStatus = "running" | "stopped" | "unknown";

export interface SandboxProcessHandle {
	id: string;
	pid: number;
	command: string;
	cwd?: string;
	stdoutPath: string;
	stderrPath: string;
	startedAt: string;
	status: ProcessStatus;
}

export interface SandboxProcessTail {
	stdout: string;
	stderr: string;
	stdoutPath: string;
	stderrPath: string;
}

export interface SandboxProcessCapability {
	start(
		command: string,
		opts?: { cwd?: string; envs?: Record<string, string>; timeoutMs?: number },
	): Promise<SandboxProcessHandle>;
	list(): Promise<SandboxProcessHandle[]>;
	tail(processId: string, opts?: { maxBytes?: number }): Promise<SandboxProcessTail>;
	stop(processId: string): Promise<{ stopped: boolean; process: SandboxProcessHandle }>;
}

export interface SandboxPortHandle {
	id: string;
	port: number;
	host: string;
	url: string;
	protocol: string;
	createdAt: string;
}

export interface SandboxPortsCapability {
	expose(port: number, opts?: { protocol?: "http" | "https" }): Promise<SandboxPortHandle>;
	list(): Promise<SandboxPortHandle[]>;
	revoke(port: number): Promise<boolean>;
}

function storeKey(prefix: string, id: string): string {
	return `${prefix}${id}`;
}

function createId(prefix: string): string {
	return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}

function positiveInt(value: unknown, fallback: number, max: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	const rounded = Math.floor(value);
	if (rounded < 1) return 1;
	if (rounded > max) return max;
	return rounded;
}

function processLogDir(processId: string): string {
	return `/tmp/parel/processes/${processId}`;
}

function backgroundCommand(command: string, stdoutPath: string, stderrPath: string): string {
	const dir = stdoutPath.slice(0, stdoutPath.lastIndexOf("/"));
	const script = `(${command}) > ${shellQuote(stdoutPath)} 2> ${shellQuote(stderrPath)}`;
	return `mkdir -p ${shellQuote(dir)} && sh -lc ${shellQuote(script)}`;
}

function portUrl(host: string, protocol: "http" | "https"): string {
	if (host.startsWith("http://") || host.startsWith("https://")) return host;
	return `${protocol}://${host}`;
}

function quoteShellArg(arg: string): string {
	if (/^[A-Za-z0-9_./:=@%+-]+$/.test(arg)) return arg;
	return `'${arg.replaceAll("'", "'\\''")}'`;
}

function commandToShell(command: SandboxCommand): string {
	return command.map(quoteShellArg).join(" ");
}

function applyShellOptions(
	command: string,
	opts?: SandboxExecOptions | SandboxShellOptions,
): string {
	const envPrefix = Object.entries(opts?.env ?? {})
		.map(([key, value]) => `${key}=${quoteShellArg(value)}`)
		.join(" ");
	const cwdPrefix = opts?.cwd ? `cd ${quoteShellArg(opts.cwd)} && ` : "";
	return `${cwdPrefix}${envPrefix ? `${envPrefix} ` : ""}${command}`;
}

function limitOutput(value: string, maxOutputChars?: number): string {
	if (!maxOutputChars || value.length <= maxOutputChars) return value;
	return value.slice(0, maxOutputChars);
}

export default definePlugin({
	name: "@parel/sandbox-e2b",

	provides: manifest.provides as ParelPlugin["provides"],
	requires: manifest.requires as ParelPlugin["requires"],
	execution: manifest.execution as ParelPlugin["execution"],
	consumes: manifest.consumes as ParelPlugin["consumes"],

	async setup(ctx) {
		const template = (ctx.config.template as string) ?? "base";
		const timeout = (ctx.config.timeout as number) ?? 300_000;

		const apiKey = ctx.config.apiKey as string | undefined;
		// Sandbox-level env vars injected at cold-start, persistent across every
		// command in the sandbox (no per-command prefix needed) — lets the host
		// hand the in-sandbox process its credentials/config at boot time.
		const envs = (ctx.config.env as Record<string, string> | undefined) ?? {};
		let sandbox: Sandbox | null = null;

		function requireSandbox(): Sandbox {
			if (!sandbox) throw new Error("E2B sandbox not available");
			return sandbox;
		}

		async function createSandbox(): Promise<Sandbox | null> {
			if (!apiKey) {
				ctx.log.warn("E2B API key not provided — skipping sandbox creation");
				return null;
			}
			const s = await Sandbox.create(template, { timeoutMs: timeout, apiKey, envs });
			await ctx.store.set(STORE_KEY, s.sandboxId);
			ctx.log.info(`E2B sandbox created: ${s.sandboxId}`);
			return s;
		}

		async function reconnectSandbox(sandboxId: string): Promise<Sandbox | null> {
			try {
				const s = await Sandbox.connect(sandboxId, { apiKey });
				ctx.log.info(`Reconnected to E2B sandbox: ${sandboxId}`);
				return s;
			} catch (err: unknown) {
				const msg = err instanceof Error ? err.message : "Unknown error";
				ctx.log.warn(`Failed to reconnect to sandbox ${sandboxId}: ${msg}`);
				return null;
			}
		}

		async function destroySandbox(): Promise<void> {
			if (!sandbox) return;
			try {
				await sandbox.kill();
				ctx.log.info(`E2B sandbox destroyed: ${sandbox.sandboxId}`);
			} catch (err: unknown) {
				const msg = err instanceof Error ? err.message : "Unknown error";
				ctx.log.warn(`Failed to destroy sandbox: ${msg}`);
			}
			sandbox = null;
			await ctx.store.delete(STORE_KEY);
		}

		// --- Lifecycle hooks ---

		ctx.hook(LifecycleEvent.SessionStart, async () => {
			sandbox = await createSandbox();
		});

		ctx.hook(LifecycleEvent.SessionEnd, async () => {
			await destroySandbox();
		});

		ctx.hook(LifecycleEvent.SessionSuspend, async () => {
			if (sandbox) {
				await ctx.store.set(STORE_KEY, sandbox.sandboxId);
				ctx.log.info(`Sandbox ID saved for resume: ${sandbox.sandboxId}`);
			}
		});

		ctx.hook(LifecycleEvent.SessionResume, async () => {
			const savedId = await ctx.store.get<string>(STORE_KEY);
			if (savedId) {
				sandbox = await reconnectSandbox(savedId);
			}
			if (!sandbox) {
				sandbox = await createSandbox();
			}
		});

		// --- Capabilities ---

		const filesystem = {
			async readFile(path: string): Promise<string> {
				return requireSandbox().files.read(path);
			},
			async writeFile(path: string, content: string): Promise<void> {
				await requireSandbox().files.write(path, content);
			},
			async exists(path: string): Promise<boolean> {
				try {
					await requireSandbox().files.read(path);
					return true;
				} catch {
					return false;
				}
			},
			async listDir(path: string): Promise<string[]> {
				const entries = await requireSandbox().files.list(path);
				return entries.map((e: { name: string }) => e.name);
			},
		};

		// Per-turn invocation context only reaches the sandbox through the local `bash`
		// tool (which passes `toolCtx.invocationContext` below). Plugins that consume the
		// provided `exec` capability via `ctx.require("exec")` (e.g. @parel/shell-tools,
		// @parel/process-tools) call `run(command)` without it, so their commands do not
		// get per-turn env in P0. Threading invocation through the capability route needs
		// per-turn delivery into the warm runtime plus each consumer forwarding it — a
		// follow-up (P1). Design: docs/invocation-context.md §6.
		const exec = {
			async run(command: string, invocation?: InvocationContext): Promise<string> {
				const turnEnv = invocationEnv(invocation);
				// E2B per-command `envs` shadow the sandbox's cold-start envs, so merge the
				// configured sandbox env (`config.env`) underneath the per-turn values — the
				// per-turn invocation context wins on key conflicts.
				const commandEnv = turnEnv ? { ...envs, ...turnEnv } : undefined;
				const result = commandEnv
					? await requireSandbox().commands.run(command, { envs: commandEnv })
					: await requireSandbox().commands.run(command);
				if (result.exitCode !== 0 && result.stderr) {
					return `Exit code: ${result.exitCode}\n${result.stderr}`;
				}
				return result.stdout;
			},
		};

		async function runShell(
			command: string,
			opts?: SandboxExecOptions | SandboxShellOptions,
		): Promise<SandboxProcessResult> {
			if (!sandbox) throw new Error("E2B sandbox not available");
			const result = await sandbox.commands.run(applyShellOptions(command, opts));
			return {
				stdout: limitOutput(result.stdout, opts?.maxOutputChars),
				stderr: limitOutput(result.stderr, opts?.maxOutputChars),
				exitCode: result.exitCode,
			};
		}

		const sandboxCapability: SandboxCapability = {
			get id() {
				return sandbox?.sandboxId;
			},
			provider: "e2b",
			supports: {
				fs: true,
				process: true,
				shell: true,
				spawn: false,
				ports: false,
				lifecycle: true,
				network: "enabled",
			},
			fs: {
				async readFile(path, opts) {
					if (!sandbox) throw new Error("E2B sandbox not available");
					const content = await sandbox.files.read(path);
					if (opts?.maxChars && content.length > opts.maxChars)
						return content.slice(0, opts.maxChars);
					return content;
				},
				async writeFile(path, content) {
					if (!sandbox) throw new Error("E2B sandbox not available");
					await sandbox.files.write(path, content);
				},
				async exists(path) {
					return filesystem.exists(path);
				},
				async listDir(path) {
					if (!sandbox) throw new Error("E2B sandbox not available");
					const entries = await sandbox.files.list(path);
					return entries.map((entry: { name: string; path?: string }) => ({
						name: entry.name,
						path: entry.path,
						type: "unknown" as const,
					}));
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
			lifecycle: {
				async isRunning() {
					return sandbox !== null;
				},
				async stop() {
					await destroySandbox();
				},
			},
		};

		const processes: SandboxProcessCapability = {
			async start(command, opts = {}) {
				if (!command.trim()) throw new Error("command must be a non-empty string");
				const s = requireSandbox();
				const id = createId("proc");
				const dir = processLogDir(id);
				const stdoutPath = `${dir}/stdout.log`;
				const stderrPath = `${dir}/stderr.log`;
				const handle = await s.commands.run(backgroundCommand(command, stdoutPath, stderrPath), {
					background: true,
					...(opts.cwd ? { cwd: opts.cwd } : {}),
					...(opts.envs ? { envs: opts.envs } : {}),
					...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
				});
				const record: SandboxProcessHandle = {
					id,
					pid: handle.pid,
					command,
					...(opts.cwd ? { cwd: opts.cwd } : {}),
					stdoutPath,
					stderrPath,
					startedAt: new Date().toISOString(),
					status: "running",
				};
				await ctx.store.set(storeKey(PROCESS_STORE_PREFIX, id), record);
				await handle.disconnect().catch((err: unknown) => {
					const msg = err instanceof Error ? err.message : "Unknown error";
					ctx.log.warn(`Failed to disconnect from background command ${id}: ${msg}`);
				});
				return record;
			},
			async list() {
				const s = requireSandbox();
				const keys = await ctx.store.list(PROCESS_STORE_PREFIX);
				const records = (
					await Promise.all(keys.map((key) => ctx.store.get<SandboxProcessHandle>(key)))
				).filter((record): record is SandboxProcessHandle => Boolean(record));
				const runningPids = new Set((await s.commands.list()).map((process) => process.pid));
				return records.map((record) => ({
					...record,
					status:
						record.status === "stopped"
							? "stopped"
							: runningPids.has(record.pid)
								? "running"
								: "unknown",
				}));
			},
			async tail(processId, opts = {}) {
				const s = requireSandbox();
				const record = await ctx.store.get<SandboxProcessHandle>(
					storeKey(PROCESS_STORE_PREFIX, processId),
				);
				if (!record) throw new Error(`unknown process: ${processId}`);
				const maxBytes = positiveInt(opts.maxBytes, 32 * 1024, 1024 * 1024);
				const readTail = async (path: string) => {
					const result = await s.commands.run(
						`tail -c ${maxBytes} ${shellQuote(path)} 2>/dev/null || true`,
					);
					return result.stdout;
				};
				return {
					stdout: await readTail(record.stdoutPath),
					stderr: await readTail(record.stderrPath),
					stdoutPath: record.stdoutPath,
					stderrPath: record.stderrPath,
				};
			},
			async stop(processId) {
				const s = requireSandbox();
				const record = await ctx.store.get<SandboxProcessHandle>(
					storeKey(PROCESS_STORE_PREFIX, processId),
				);
				if (!record) throw new Error(`unknown process: ${processId}`);
				const stopped = await s.commands.kill(record.pid);
				const next: SandboxProcessHandle = { ...record, status: "stopped" };
				await ctx.store.set(storeKey(PROCESS_STORE_PREFIX, processId), next);
				return { stopped, process: next };
			},
		};

		const ports: SandboxPortsCapability = {
			async expose(port, opts = {}) {
				const normalizedPort = positiveInt(port, 0, 65_535);
				if (normalizedPort < 1 || normalizedPort > 65_535) {
					throw new Error("port must be between 1 and 65535");
				}
				const protocol = opts.protocol ?? "https";
				const host = requireSandbox().getHost(normalizedPort);
				const handle: SandboxPortHandle = {
					id: String(normalizedPort),
					port: normalizedPort,
					host,
					protocol,
					url: portUrl(host, protocol),
					createdAt: new Date().toISOString(),
				};
				await ctx.store.set(storeKey(PORT_STORE_PREFIX, handle.id), handle);
				return handle;
			},
			async list() {
				const keys = await ctx.store.list(PORT_STORE_PREFIX);
				return (await Promise.all(keys.map((key) => ctx.store.get<SandboxPortHandle>(key)))).filter(
					(record): record is SandboxPortHandle => Boolean(record),
				);
			},
			async revoke(port) {
				const normalizedPort = positiveInt(port, 0, 65_535);
				const key = storeKey(PORT_STORE_PREFIX, String(normalizedPort));
				const existing = await ctx.store.get<SandboxPortHandle>(key);
				if (!existing) return false;
				await ctx.store.delete(key);
				return true;
			},
		};

		ctx.provide("filesystem", filesystem);
		ctx.provide("exec", exec);
		ctx.provide(PAREL_SANDBOX_CAPABILITY, sandboxCapability);
		ctx.provide("process", processes);
		ctx.provide("ports", ports);

		// --- Tools ---

		ctx.tool(
			{
				name: "bash",
				description: "Execute a bash command in the E2B cloud sandbox",
				parameters: {
					type: "object",
					properties: {
						command: { type: "string", description: "The command to run" },
					},
					required: ["command"],
				},
			},
			async (params, toolCtx) => exec.run(params.command as string, toolCtx.invocationContext),
		);

		ctx.tool(
			{
				name: "file_read",
				description: "Read a file from the E2B cloud sandbox",
				parameters: {
					type: "object",
					properties: {
						path: { type: "string", description: "Absolute file path to read" },
					},
					required: ["path"],
				},
			},
			async (params) => filesystem.readFile(params.path as string),
		);

		ctx.tool(
			{
				name: "file_write",
				description: "Write content to a file in the E2B cloud sandbox",
				parameters: {
					type: "object",
					properties: {
						path: { type: "string", description: "Absolute file path to write" },
						content: { type: "string", description: "Content to write" },
					},
					required: ["path", "content"],
				},
			},
			async (params) => {
				await filesystem.writeFile(params.path as string, params.content as string);
				return "File written successfully";
			},
		);
	},
});
