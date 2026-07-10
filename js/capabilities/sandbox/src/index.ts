export const PAREL_SANDBOX_CAPABILITY = "parel.sandbox";

export type SandboxCommand = readonly [program: string, ...args: string[]];
export type SandboxFileType = "file" | "directory" | "symlink" | "unknown";
export type SandboxFileEncoding = "utf8" | "base64";
export type SandboxNetworkAccess = "enabled" | "disabled" | "restricted" | "unknown";
export type SandboxPortProtocol = "http" | "https" | "tcp";
export type SandboxProcessStatus = "running" | "exited" | "failed" | "killed" | "unknown";

export interface SandboxSupport {
	fs?: boolean;
	process?: boolean;
	shell?: boolean;
	spawn?: boolean;
	ports?: boolean;
	lifecycle?: boolean;
	network?: SandboxNetworkAccess;
}

export interface SandboxFileEntry {
	name: string;
	path?: string;
	type?: SandboxFileType;
	size?: number;
	mtimeMs?: number;
}

export interface SandboxFileStat {
	path: string;
	type: SandboxFileType;
	size?: number;
	mtimeMs?: number;
	mode?: number;
}

export interface SandboxReadFileOptions {
	encoding?: SandboxFileEncoding;
	offset?: number;
	limit?: number;
	maxChars?: number;
}

export interface SandboxWriteFileOptions {
	encoding?: SandboxFileEncoding;
	append?: boolean;
}

export interface SandboxFs {
	readFile(path: string, opts?: SandboxReadFileOptions): Promise<string>;
	writeFile(path: string, content: string, opts?: SandboxWriteFileOptions): Promise<void>;
	listDir(path: string): Promise<SandboxFileEntry[]>;
	stat?(path: string): Promise<SandboxFileStat>;
	exists?(path: string): Promise<boolean>;
	mkdir?(path: string, opts?: { recursive?: boolean }): Promise<void>;
	remove?(path: string, opts?: { recursive?: boolean }): Promise<void>;
	rename?(from: string, to: string): Promise<void>;
}

export interface SandboxExecOptions {
	cwd?: string;
	timeoutMs?: number;
	maxOutputChars?: number;
	env?: Record<string, string>;
	stdin?: string;
}

export interface SandboxShellOptions extends SandboxExecOptions {
	shell?: string;
}

export interface SandboxSpawnOptions extends SandboxExecOptions {
	name?: string;
	detached?: boolean;
}

export interface SandboxProcessResult {
	stdout: string;
	stderr: string;
	exitCode: number;
	signal?: string;
	timedOut?: boolean;
	metadata?: Record<string, unknown>;
}

export interface SandboxProcessOutputOptions {
	offset?: number;
	maxChars?: number;
}

export interface SandboxProcessHandle {
	id: string;
	command?: SandboxCommand;
	status(): Promise<SandboxProcessStatus>;
	wait(opts?: { timeoutMs?: number }): Promise<SandboxProcessResult>;
	kill(signal?: string): Promise<void>;
	stdout?(opts?: SandboxProcessOutputOptions): Promise<string>;
	stderr?(opts?: SandboxProcessOutputOptions): Promise<string>;
	writeStdin?(input: string): Promise<void>;
}

export interface SandboxProcess {
	exec(command: SandboxCommand, opts?: SandboxExecOptions): Promise<SandboxProcessResult>;
	shell?(command: string, opts?: SandboxShellOptions): Promise<SandboxProcessResult>;
	spawn?(command: SandboxCommand, opts?: SandboxSpawnOptions): Promise<SandboxProcessHandle>;
}

export interface SandboxPort {
	port: number;
	url: string;
	protocol?: SandboxPortProtocol;
	expiresAt?: string;
	metadata?: Record<string, unknown>;
}

export interface SandboxPorts {
	expose(
		port: number,
		opts?: { protocol?: SandboxPortProtocol; label?: string },
	): Promise<SandboxPort>;
	unexpose?(port: number): Promise<void>;
}

export interface SandboxLifecycle {
	isRunning(): Promise<boolean>;
	stop(): Promise<void>;
	extendTimeout?(timeoutMs: number): Promise<void>;
}

export interface SandboxCapability {
	id?: string;
	provider: string;
	cwd?: string;
	supports?: SandboxSupport;
	fs?: SandboxFs;
	process?: SandboxProcess;
	ports?: SandboxPorts;
	lifecycle?: SandboxLifecycle;
	metadata?: Record<string, unknown>;
}

// --- Simple capability views ---------------------------------------------
//
// The workspace and *-tools plugins consume flat capability ids ("filesystem",
// "exec", "process", "ports") with simpler shapes than SandboxCapability.
// createSandboxCapabilityViews derives all four from a SandboxCapability plus
// the provider's plugin store, so every sandbox provider exposes the same
// surface by calling it once after assembling its capability.

export interface SandboxFilesystemView {
	readFile(path: string, opts?: SandboxReadFileOptions): Promise<string>;
	writeFile(path: string, content: string): Promise<void>;
	exists(path: string): Promise<boolean>;
	listDir(path: string): Promise<string[]>;
}

export interface SandboxExecView {
	run(command: string): Promise<string>;
}

export interface SandboxProcessRecord {
	id: string;
	pid: number;
	command: string;
	cwd?: string;
	stdoutPath: string;
	stderrPath: string;
	startedAt: string;
	status: "running" | "stopped" | "unknown";
}

export interface SandboxProcessTailResult {
	stdout: string;
	stderr: string;
	stdoutPath: string;
	stderrPath: string;
}

export interface SandboxProcessView {
	start(
		command: string,
		opts?: { cwd?: string; envs?: Record<string, string>; timeoutMs?: number },
	): Promise<SandboxProcessRecord>;
	list(): Promise<SandboxProcessRecord[]>;
	tail(processId: string, opts?: { maxBytes?: number }): Promise<SandboxProcessTailResult>;
	stop(processId: string): Promise<{ stopped: boolean; process: SandboxProcessRecord }>;
}

export interface SandboxPortRecord {
	id: string;
	port: number;
	host: string;
	url: string;
	protocol: string;
	createdAt: string;
}

export interface SandboxPortsView {
	expose(port: number, opts?: { protocol?: "http" | "https" }): Promise<SandboxPortRecord>;
	list(): Promise<SandboxPortRecord[]>;
	revoke(port: number): Promise<boolean>;
}

/** Minimal structural slice of a plugin store (matches plugin-sdk ctx.store). */
export interface SandboxViewStore {
	get<T = unknown>(key: string): Promise<T | null | undefined>;
	set(key: string, value: unknown): Promise<unknown>;
	delete(key: string): Promise<unknown>;
	list(prefix: string): Promise<string[]>;
}

export interface SandboxCapabilityViews {
	filesystem: SandboxFilesystemView;
	exec: SandboxExecView;
	process: SandboxProcessView;
	ports: SandboxPortsView;
}

const PROCESS_VIEW_STORE_PREFIX = "sandbox_process:";
const PORT_VIEW_STORE_PREFIX = "sandbox_port:";

function viewShellQuote(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}

function viewCreateId(prefix: string): string {
	return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function clampBytes(value: number | undefined, fallback: number, max: number): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return fallback;
	return Math.min(Math.floor(value), max);
}

export function createSandboxCapabilityViews(
	capability: SandboxCapability,
	store: SandboxViewStore,
): SandboxCapabilityViews {
	const requireFs = (): SandboxFs => {
		if (!capability.fs) {
			throw new Error(`Sandbox provider ${capability.provider} does not support filesystem access`);
		}
		return capability.fs;
	};

	const shell = async (
		command: string,
		opts?: SandboxShellOptions,
	): Promise<SandboxProcessResult> => {
		const proc = capability.process;
		if (!proc) {
			throw new Error(`Sandbox provider ${capability.provider} does not support process execution`);
		}
		if (proc.shell) return proc.shell(command, opts);
		return proc.exec(["sh", "-lc", command], opts);
	};

	const filesystem: SandboxFilesystemView = {
		async readFile(path, opts) {
			return requireFs().readFile(path, opts);
		},
		async writeFile(path, content) {
			await requireFs().writeFile(path, content);
		},
		async exists(path) {
			const fs = requireFs();
			if (fs.exists) return fs.exists(path);
			try {
				await fs.readFile(path);
				return true;
			} catch {
				return false;
			}
		},
		async listDir(path) {
			return (await requireFs().listDir(path)).map((entry) => entry.name);
		},
	};

	const exec: SandboxExecView = {
		async run(command) {
			const result = await shell(command);
			if (result.exitCode !== 0) {
				const detail = [result.stdout, result.stderr].filter(Boolean).join("\n");
				return `Exit code: ${result.exitCode}${detail ? `\n${detail}` : ""}`;
			}
			return result.stdout;
		},
	};

	const processKey = (id: string) => `${PROCESS_VIEW_STORE_PREFIX}${id}`;

	const process: SandboxProcessView = {
		async start(command, opts = {}) {
			if (!command.trim()) throw new Error("command must be a non-empty string");
			const id = viewCreateId("proc");
			const dir = `/tmp/parel/processes/${id}`;
			const stdoutPath = `${dir}/stdout.log`;
			const stderrPath = `${dir}/stderr.log`;
			const script = `(${command}) > ${viewShellQuote(stdoutPath)} 2> ${viewShellQuote(stderrPath)}`;
			// Launch in its own session/process group so stop() can kill the whole
			// tree: prefer setsid (real new session, works without a tty); fall back
			// to `sh -m` job control where setsid is unavailable.
			const runner = `nohup sh -lc ${viewShellQuote(script)} >/dev/null 2>&1 & echo $!`;
			const launch =
				`mkdir -p ${viewShellQuote(dir)} && ` +
				`if command -v setsid >/dev/null 2>&1; then setsid ${runner}; ` +
				`else sh -lmc ${viewShellQuote(runner)}; fi`;
			const result = await shell(launch, {
				...(opts.cwd ? { cwd: opts.cwd } : {}),
				...(opts.envs ? { env: opts.envs } : {}),
				...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
			});
			const pid = Number.parseInt(result.stdout.trim().split("\n").pop() ?? "", 10);
			if (!Number.isFinite(pid) || pid <= 0) {
				throw new Error(`Failed to start background process: ${result.stderr || result.stdout}`);
			}
			const record: SandboxProcessRecord = {
				id,
				pid,
				command,
				...(opts.cwd ? { cwd: opts.cwd } : {}),
				stdoutPath,
				stderrPath,
				startedAt: new Date().toISOString(),
				status: "running",
			};
			await store.set(processKey(id), record);
			return record;
		},
		async list() {
			const keys = await store.list(PROCESS_VIEW_STORE_PREFIX);
			const records = (
				await Promise.all(keys.map((key) => store.get<SandboxProcessRecord>(key)))
			).filter((record): record is SandboxProcessRecord => Boolean(record));
			if (records.length === 0) return [];
			const pids = records.map((record) => record.pid).join(" ");
			const probe = await shell(
				`for p in ${pids}; do kill -0 "$p" 2>/dev/null && echo "$p"; done; true`,
			);
			const running = new Set(
				probe.stdout
					.split("\n")
					.map((line) => Number.parseInt(line.trim(), 10))
					.filter((pid) => Number.isFinite(pid)),
			);
			return records.map((record) => ({
				...record,
				status:
					record.status === "stopped" ? "stopped" : running.has(record.pid) ? "running" : "unknown",
			}));
		},
		async tail(processId, opts = {}) {
			const record = await store.get<SandboxProcessRecord>(processKey(processId));
			if (!record) throw new Error(`unknown process: ${processId}`);
			const maxBytes = clampBytes(opts.maxBytes, 32 * 1024, 1024 * 1024);
			const readTail = async (path: string) => {
				const result = await shell(
					`tail -c ${maxBytes} ${viewShellQuote(path)} 2>/dev/null || true`,
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
			const record = await store.get<SandboxProcessRecord>(processKey(processId));
			if (!record) throw new Error(`unknown process: ${processId}`);
			// Kill the process group (created via setsid/job control at launch) and
			// the wrapper pid, then verify against the whole group — not just the
			// wrapper — so lingering children are reported instead of leaked.
			const result = await shell(
				`kill -- -${record.pid} 2>/dev/null; kill ${record.pid} 2>/dev/null; sleep 0.2; ` +
					`if kill -0 -- -${record.pid} 2>/dev/null || kill -0 ${record.pid} 2>/dev/null; ` +
					`then echo still-alive; fi`,
			);
			const stopped = !result.stdout.includes("still-alive");
			const next: SandboxProcessRecord = {
				...record,
				status: stopped ? "stopped" : record.status,
			};
			await store.set(processKey(processId), next);
			return { stopped, process: next };
		},
	};

	const portKey = (id: string) => `${PORT_VIEW_STORE_PREFIX}${id}`;

	const ports: SandboxPortsView = {
		async expose(port, opts = {}) {
			if (!capability.ports) {
				throw new Error(`Sandbox provider ${capability.provider} does not support ports`);
			}
			const protocol = opts.protocol ?? "https";
			const exposed = await capability.ports.expose(port, { protocol });
			const url = exposed.url.includes("://") ? exposed.url : `${protocol}://${exposed.url}`;
			const host = url.replace(/^[a-z]+:\/\//, "");
			const record: SandboxPortRecord = {
				id: String(exposed.port),
				port: exposed.port,
				host,
				url,
				protocol: exposed.protocol ?? protocol,
				createdAt: new Date().toISOString(),
			};
			await store.set(portKey(record.id), record);
			return record;
		},
		async list() {
			const keys = await store.list(PORT_VIEW_STORE_PREFIX);
			return (await Promise.all(keys.map((key) => store.get<SandboxPortRecord>(key)))).filter(
				(record): record is SandboxPortRecord => Boolean(record),
			);
		},
		async revoke(port) {
			const key = portKey(String(port));
			const existing = await store.get<SandboxPortRecord>(key);
			if (!existing) return false;
			// Tear down the route for real; claiming success while the URL stays
			// live (and dropping the only record of it) would be worse than failing.
			if (!capability.ports?.unexpose) {
				throw new Error(
					`Sandbox provider ${capability.provider} cannot unexpose ports; ` +
						"the exposed URL stays live until the sandbox stops",
				);
			}
			await capability.ports.unexpose(existing.port);
			await store.delete(key);
			return true;
		},
	};

	return { filesystem, exec, process, ports };
}
