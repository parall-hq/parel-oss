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
	type SandboxViewStore,
} from "@parel/capability-sandbox";
import { definePlugin, LifecycleEvent, type ParelPlugin } from "@parel/plugin-sdk";
import { Sandbox as VercelSandboxClient } from "@vercel/sandbox";
import manifest from "../parel.plugin.json" with { type: "json" };

// Vercel keys a sandbox by its NAME (auto-generated on create, stable across
// reconnects), so the handle we persist is the name, not an opaque id.
const STORE_KEY = "vercel_sandbox_name";
// Process/port records written by the shared capability views. In instance mode
// they describe state inside the shared sandbox, so they must live wherever the
// sandbox lives (the instance store) — sibling sessions have to see them.
const PROCESS_VIEW_STORE_PREFIX = "sandbox_process:";
const PORT_VIEW_STORE_PREFIX = "sandbox_port:";

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
		// For Vercel the name IS the handle, so an explicitly configured name means
		// the user pinned a specific sandbox and manages its identity outside PAREL.
		// In instance mode we connect to it directly (getOrCreate by name) and never
		// race, kill, or migrate it — the escape hatch stays externally owned.
		const externalName = stringConfig(ctx.config.name);

		// Instance-scoped state (docs/agent-instance-model.md §4.3): when the host
		// provides ctx.instanceStore the sandbox belongs to the AGENT INSTANCE —
		// every session shares one sandbox, a conversation reset keeps it, and
		// ending one session must not kill it. On hosts without instance storage
		// (istore === undefined) behavior stays exactly per-session — explicit
		// probing, no silent downgrade of the sharing promise.
		const istore = ctx.instanceStore;
		// Process/port records live wherever the sandbox lives: they describe state
		// inside the shared machine, so sibling sessions must see them. The shared
		// capability views read/write through this bucket.
		const state: SandboxViewStore = istore
			? {
					async get<T>(key: string): Promise<T | null> {
						return (await istore.get<T>(key))?.value ?? null;
					},
					set(key: string, value: unknown): Promise<void> {
						return istore.set(key, value);
					},
					delete(key: string): Promise<void> {
						return istore.delete(key);
					},
					list(prefix: string): Promise<string[]> {
						return istore.list(prefix);
					},
				}
			: ctx.store;
		// Instance mode splits into two shapes: a managed shared sandbox coordinated
		// through cas() (no external pin), or a plain connect to an externally owned
		// named sandbox. Only the managed shape runs the CAS/authority/migration
		// machinery.
		const managed = Boolean(istore) && !externalName;

		let sandbox: VercelSandbox | null = null;
		let sandboxRecovery: Promise<VercelSandbox | null> | null = null;
		// Bumped on teardown so an in-flight recovery can tell its result is stale
		// and must not be published (or leak) after the session ended.
		let sandboxEpoch = 0;

		function credentials(): Record<string, string> | null {
			if (!token || !teamId || !projectId) {
				ctx.log.warn("Vercel Sandbox token, teamId, and projectId are required");
				return null;
			}
			return { token, teamId, projectId };
		}

		// Create a brand-new sandbox with an auto-generated name. Does NOT publish
		// any handle — the caller owns where the name is recorded (per-session store
		// vs instance-store cas). Only reached in managed mode, where no external
		// name is configured, so the created sandbox gets a fresh unique name.
		async function createRawSandbox(): Promise<VercelSandbox | null> {
			const creds = credentials();
			if (!creds) return null;
			const params = { ...buildCreateParams(ctx.config), ...creds };
			const created = (await VercelSandboxClient.create(params)) as unknown as VercelSandbox;
			ctx.log.info(`Vercel sandbox created: ${created.name}`);
			return created;
		}

		// Reconnect to an existing sandbox by name WITHOUT creating one (get, not
		// getOrCreate). Returns null (not throw) when it is unreachable so the
		// managed acquire can decide to replace it. Does NOT publish any handle.
		async function reconnectSandbox(name: string): Promise<VercelSandbox | null> {
			const creds = credentials();
			if (!creds) return null;
			try {
				const s = (await VercelSandboxClient.get({ name, ...creds })) as unknown as VercelSandbox;
				ctx.log.info(`Vercel sandbox connected: ${name}`);
				return s;
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				ctx.log.warn(`Failed to connect Vercel sandbox ${name}: ${message}`);
				return null;
			}
		}

		// Best-effort kill by name. Vercel deletes via a live handle, so reconnect
		// (get, never getOrCreate — a kill must not resurrect the sandbox) then
		// delete. A reconnect failure means it is already gone — we report false.
		async function killSandboxById(name: string): Promise<boolean> {
			const creds = credentials();
			if (!creds) return false;
			try {
				const s = (await VercelSandboxClient.get({ name, ...creds })) as unknown as VercelSandbox;
				await s.delete();
				return true;
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				ctx.log.warn(`Failed to kill Vercel sandbox ${name}: ${message}`);
				return false;
			}
		}

		// Process/port records belong to their sandbox. When the legacy sandbox is
		// promoted they must follow it into the instance store (its background
		// processes/ports are still live — dropping the records would blind
		// list/tail/stop/revoke); when it is reaped or dead they are ghosts and must
		// be deleted instead.
		async function moveLegacyRecords(promote: boolean): Promise<void> {
			for (const prefix of [PROCESS_VIEW_STORE_PREFIX, PORT_VIEW_STORE_PREFIX]) {
				for (const key of await ctx.store.list(prefix)) {
					if (promote) {
						const record = await ctx.store.get(key);
						if (record !== null) await state.set(key, record);
					}
					await ctx.store.delete(key);
				}
			}
		}

		// Destroying the sandbox kills the processes and tears down the ports inside
		// it, so their records are ghosts. Clear them from wherever they live (the
		// instance store in shared mode) so a sibling — or the next sandbox created
		// under this instance — never sees stale entries as its own.
		async function clearViewRecords(): Promise<void> {
			for (const prefix of [PROCESS_VIEW_STORE_PREFIX, PORT_VIEW_STORE_PREFIX]) {
				for (const key of await state.list(prefix)) {
					await state.delete(key);
				}
			}
		}

		// One-time migration sweep for a pre-instance-mode session: a legacy
		// per-session handle either becomes the instance's authoritative sandbox
		// (files survive the upgrade), or — when a sibling's sandbox already holds
		// authority — it is an orphan that MUST be reaped. Runs before every managed
		// acquire; a missing legacy key makes it free.
		async function migrateLegacyHandle(): Promise<void> {
			if (!istore) return;
			const legacy = await ctx.store.get<string>(STORE_KEY);
			if (!legacy) return;
			const authoritative = await istore.get<string>(STORE_KEY);
			if (!authoritative) {
				const reconnected = await reconnectSandbox(legacy);
				if (!reconnected) {
					// Dead handle — nothing to promote or reap.
					await ctx.store.delete(STORE_KEY);
					await moveLegacyRecords(false);
					return;
				}
				if (await istore.cas(STORE_KEY, null, legacy)) {
					await ctx.store.delete(STORE_KEY);
					await moveLegacyRecords(true);
					ctx.log.info(`Vercel sandbox ${legacy} migrated to the instance store`);
					return;
				}
				// Lost the promotion race — fall through to the orphan check.
			}
			if ((await istore.get<string>(STORE_KEY))?.value !== legacy) {
				await killSandboxById(legacy);
				ctx.log.info(`Vercel legacy sandbox ${legacy} reaped (instance already has a sandbox)`);
			}
			await ctx.store.delete(STORE_KEY);
			await moveLegacyRecords(false);
		}

		// Instance mode (managed): acquire the ONE sandbox shared by every session of
		// this agent instance. The authoritative name lives in the instance store;
		// all mutations go through cas() because sibling sessions' turns race here.
		// The loser of any race kills its own orphan and adopts the winner on the
		// next pass.
		async function acquireSharedSandbox(): Promise<VercelSandbox | null> {
			if (!istore) throw new Error("acquireSharedSandbox requires an instance store");
			await migrateLegacyHandle();
			for (let attempt = 0; attempt < 3; attempt++) {
				const entry = await istore.get<string>(STORE_KEY);
				if (entry) {
					const reconnected = await reconnectSandbox(entry.value);
					if (reconnected) {
						// A sibling may have swapped the handle while we were
						// reconnecting — the superseded sandbox can still answer before
						// the sibling's delete lands. Only adopt if it is still
						// authoritative; otherwise retry against the current one.
						const current = await istore.get<string>(STORE_KEY);
						if (current?.value === entry.value) return reconnected;
						continue;
					}
					// Authoritative sandbox unreachable — replace it, guarded by the
					// observed version so only one sibling wins the swap. Create the
					// replacement FIRST so a creation failure leaves the old name intact.
					const fresh = await createRawSandbox();
					if (!fresh) return null;
					if (await istore.cas(STORE_KEY, entry.version, fresh.name)) {
						ctx.log.warn(
							`Vercel filesystem reset: sandbox ${entry.value} was unreachable, swapped in ${fresh.name} (files in the previous sandbox are lost)`,
						);
						await killSandboxById(entry.value);
						// The unreachable sandbox took its processes/ports with it — its
						// records would otherwise be read as belonging to the fresh one.
						await clearViewRecords();
						return fresh;
					}
					// A sibling already swapped in its replacement — discard ours.
					await killSandboxById(fresh.name);
					continue;
				}
				const fresh = await createRawSandbox();
				if (!fresh) return null;
				if (await istore.cas(STORE_KEY, null, fresh.name)) return fresh;
				// Lost the cold-start race — exactly one sibling won; use theirs.
				await killSandboxById(fresh.name);
			}
			throw new Error("Vercel sandbox acquisition kept losing instance-store races; giving up");
		}

		// Per-session (and external-pin) acquire: getOrCreate a configured/stored
		// named sandbox, else create fresh. Publishes to the session store. This is
		// the historical one-sandbox-per-session path, unchanged.
		async function acquirePerSession(): Promise<VercelSandbox | null> {
			const creds = credentials();
			if (!creds) return null;
			const savedName = await ctx.store.get<string>(STORE_KEY);
			const name = stringConfig(ctx.config.name) ?? savedName;
			const params = { ...buildCreateParams(ctx.config), ...creds };
			let next: VercelSandbox;
			if (name) {
				next = (await VercelSandboxClient.getOrCreate({
					...params,
					name,
				})) as unknown as VercelSandbox;
			} else {
				next = (await VercelSandboxClient.create(params)) as unknown as VercelSandbox;
			}
			await ctx.store.set(STORE_KEY, next.name);
			ctx.log.info(`Vercel sandbox ready: ${next.name}`);
			return next;
		}

		// Mode dispatch: a managed instance shares one sandbox per agent instance;
		// per-session and external-pin modes keep the connect-or-create behavior.
		function acquire(): Promise<VercelSandbox | null> {
			return managed ? acquireSharedSandbox() : acquirePerSession();
		}

		// Tool/capability call path. Lifecycle hooks stay the warm path; this is the
		// fallback for when they were skipped or misfired, so the first tool call
		// self-heals instead of the whole turn failing on a dead sandbox.
		// Single-flight: concurrent calls await one shared recovery. A failed
		// recovery clears the slot so the next call retries rather than caching it.
		async function ensureSandbox(): Promise<VercelSandbox | null> {
			// Capture the cached handle BEFORE any await: two concurrent tool calls
			// can enter together, and the first to notice a stale handle nulls the
			// shared `sandbox` — the second must compare against its own captured
			// reference, not re-read the mutated slot.
			const cached = sandbox;
			if (cached) {
				// Per-session and external-pin modes never swap the handle behind our
				// back, so a cached handle is always current.
				if (!managed) return cached;
				// Managed instance mode: a sibling may have replaced the shared
				// sandbox (unreachable → swap). A cached local handle would strand
				// this session on the dead machine, silently splitting the instance's
				// "one shared filesystem".
				const authoritative = await istore?.get<string>(STORE_KEY);
				if (authoritative?.value === cached.name) return cached;
				if (sandbox === cached) sandbox = null; // stale — re-acquire below
			}
			if (!sandboxRecovery) {
				const epoch = sandboxEpoch;
				sandboxRecovery = acquire()
					.then(async (s) => {
						if (epoch !== sandboxEpoch) {
							// The session tore down while this recovery was in flight.
							if (managed) {
								// The acquired sandbox is (or just became) the instance's
								// shared sandbox — sibling sessions own it too, so just drop
								// our reference. Any orphan we created and lost a race with
								// was already reaped inside acquireSharedSandbox.
								throw new Error("Vercel sandbox recovery discarded: session torn down");
							}
							// Per-session mode: nothing else will ever clean it up — reap it
							// (respecting destroyOnSessionEnd) and stay torn down.
							if (s && destroyOnSessionEnd) {
								await killSandboxById(s.name);
								await ctx.store.delete(STORE_KEY);
							}
							throw new Error("Vercel sandbox was torn down during recovery");
						}
						sandbox = s;
						return s;
					})
					.finally(() => {
						sandboxRecovery = null;
					});
			}
			return sandboxRecovery;
		}

		async function requireSandbox(): Promise<VercelSandbox> {
			const s = await ensureSandbox();
			if (!s) throw new Error("Vercel sandbox not available");
			return s;
		}

		// Drop this session's reference to the shared sandbox WITHOUT killing it: in
		// instance mode the sandbox belongs to the agent instance, and sibling
		// sessions (or the next conversation) keep using it.
		async function releaseSandbox(): Promise<void> {
			sandboxEpoch++;
			if (sandboxRecovery) {
				await sandboxRecovery.catch(() => {});
			}
			sandbox = null;
		}

		// Explicit destruction (lifecycle.stop, or SessionEnd for an ephemeral
		// instance). In instance mode this kills the INSTANCE's sandbox — only
		// reachable via an explicit stop or an ephemeral teardown, never from a
		// session merely ending.
		async function destroySandbox(): Promise<void> {
			sandboxEpoch++;
			if (sandboxRecovery) {
				await sandboxRecovery.catch(() => {});
			}
			if (istore) {
				sandbox = null;
				// An externally pinned sandbox never wrote the instance-store handle, so
				// there is no entry to retire and nothing for PAREL to kill — its
				// lifecycle stays the user's (we only drop our local reference above).
				const entry = await istore.get<string>(STORE_KEY);
				if (entry) {
					// Retire the handle BEFORE killing, and only the exact version we
					// observed: a sibling may be swapping in a replacement right now, and
					// an unconditional delete would erase its fresh name without killing
					// that sandbox (a live orphan). casDelete makes the race explicit — if
					// we lose, the handle now points at a different sandbox and this stop
					// no longer owns the kill.
					const retired = (await istore.casDelete?.(STORE_KEY, entry.version)) ?? false;
					if (!retired && istore.casDelete) {
						ctx.log.warn("Vercel stop skipped: the instance sandbox changed mid-stop");
						await ctx.store.delete(STORE_KEY);
						return;
					}
					if (!istore.casDelete) await istore.delete(STORE_KEY); // legacy host fallback
					if (await killSandboxById(entry.value)) {
						ctx.log.info(`Vercel sandbox destroyed: ${entry.value}`);
					}
					// The retired sandbox took its processes/ports with it — clear their
					// now-ghost records so the next sandbox does not inherit them.
					await clearViewRecords();
				}
				await ctx.store.delete(STORE_KEY);
				return;
			}
			const target = sandbox?.name ?? (await ctx.store.get<string>(STORE_KEY));
			sandbox = null;
			if (target && (await killSandboxById(target))) {
				ctx.log.info(`Vercel sandbox destroyed: ${target}`);
			}
			await clearViewRecords();
			await ctx.store.delete(STORE_KEY);
		}

		// Per-session SessionEnd: honor destroyOnSessionEnd (delete vs stop). Kept
		// byte-identical to the historical behavior.
		async function disposeSandbox(): Promise<void> {
			sandboxEpoch++;
			if (sandboxRecovery) {
				await sandboxRecovery.catch(() => {});
			}
			const current = sandbox;
			sandbox = null;
			if (!current) return;
			if (destroyOnSessionEnd) {
				await current.delete();
				await ctx.store.delete(STORE_KEY);
			} else {
				await current.stop();
			}
		}

		async function execCommand(
			command: SandboxCommand,
			opts?: SandboxExecOptions,
		): Promise<SandboxProcessResult> {
			const s = await requireSandbox();
			const finished = (await s.runCommand(runParams(command, opts))) as VercelCommandFinished;
			return commandResult(finished, opts);
		}

		async function shellCommand(
			command: string,
			opts?: SandboxShellOptions,
		): Promise<SandboxProcessResult> {
			const shell = opts?.shell ?? "sh";
			const s = await requireSandbox();
			const finished = (await s.runCommand({
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
					const s = await requireSandbox();
					const content = await s.fs.readFile(path, {
						encoding: opts?.encoding === "base64" ? null : "utf8",
					});
					const text = Buffer.isBuffer(content) ? content.toString("base64") : content;
					return opts?.maxChars ? limitOutput(text, opts.maxChars) : text;
				},
				async writeFile(path, content, opts) {
					const s = await requireSandbox();
					const data = opts?.encoding === "base64" ? Buffer.from(content, "base64") : content;
					if (opts?.append && s.fs.appendFile) {
						await s.fs.appendFile(path, data);
					} else {
						await s.fs.writeFile(path, data);
					}
				},
				async listDir(path) {
					const s = await requireSandbox();
					return (await s.fs.readdir(path, { withFileTypes: true })).map((entry) => ({
						name: entry.name,
						type: mapDirentType(entry),
					}));
				},
				async stat(path) {
					const s = await requireSandbox();
					const stats = await s.fs.stat(path);
					return {
						path,
						type: mapStatsType(stats),
						size: stats.size,
						mtimeMs: stats.mtimeMs,
						mode: stats.mode,
					} satisfies SandboxFileStat;
				},
				async exists(path) {
					const s = await requireSandbox();
					return s.fs.exists(path);
				},
				async mkdir(path, opts) {
					const s = await requireSandbox();
					await s.fs.mkdir(path, { recursive: opts?.recursive });
				},
				async remove(path, opts) {
					const s = await requireSandbox();
					await s.fs.rm(path, { recursive: opts?.recursive, force: true });
				},
				async rename(from, to) {
					const s = await requireSandbox();
					await s.fs.rename(from, to);
				},
			},
			process: {
				exec: execCommand,
				shell: shellCommand,
				async spawn(command, opts) {
					const s = await requireSandbox();
					const handle = (await s.runCommand({
						...runParams(command, opts),
						detached: true,
					})) as VercelCommand;
					return processHandle(handle, command);
				},
			},
			ports: {
				async expose(port) {
					const s = await requireSandbox();
					return { port, url: s.domain(port), protocol: "https" };
				},
			},
			lifecycle: {
				async isRunning() {
					// A pure status query: reports the current state and must not
					// side-effect a sandbox into existence like requireSandbox would.
					// No cached handle (released or destroyed) means not running — do
					// not let `undefined ?? "running"` report a torn-down sandbox as up.
					if (!sandbox) return false;
					return String(sandbox.status ?? "running") === "running";
				},
				async stop() {
					// Instance mode: retire and kill the shared sandbox. Per-session mode
					// keeps its historical stop-only behavior — Vercel's stop preserves
					// the named sandbox for a later reconnect.
					if (istore) {
						await destroySandbox();
						return;
					}
					if (!sandbox) throw new Error("Vercel sandbox not available");
					await sandbox.stop();
				},
				async extendTimeout(timeoutMs) {
					const s = await requireSandbox();
					await s.extendTimeout?.(timeoutMs);
				},
			},
		};

		ctx.hook(LifecycleEvent.SessionStart, async () => {
			// Instance mode adopts the instance's existing sandbox instead of
			// unconditionally creating one — this is where sibling sessions start
			// sharing a machine.
			sandbox = await acquire();
		});

		ctx.hook(LifecycleEvent.SessionResume, async () => {
			// Reconnect unconditionally: a stale in-memory handle may point at a
			// sandbox that has since stopped. Clear the handle first — if the resume
			// fails entirely, a lingering stale handle would satisfy requireSandbox
			// forever and block the self-healing retry.
			sandbox = null;
			sandbox = await acquire();
		});

		ctx.hook(LifecycleEvent.SessionSuspend, async () => {
			// Instance mode: the authoritative handle is already in the instance store
			// (written at creation/adoption) — nothing to save.
			if (!istore && sandbox) await ctx.store.set(STORE_KEY, sandbox.name);
		});

		ctx.hook(LifecycleEvent.SessionEnd, async () => {
			// Per-session mode: honor destroyOnSessionEnd, unchanged.
			if (!istore) {
				await disposeSandbox();
				return;
			}
			// Ephemeral instance (try-run/replay) dies with the session: its store is
			// discarded, so nothing could ever stop the sandbox later — destroy it.
			if (ctx.instance?.ephemeral) {
				await destroySandbox();
				return;
			}
			// The conversation ends, the entity lives on — drop the local handle,
			// keep the shared sandbox for sibling sessions and the next conversation.
			await releaseSandbox();
		});

		ctx.provide(PAREL_SANDBOX_CAPABILITY, capability);
		const views = createSandboxCapabilityViews(capability, state);
		ctx.provide("filesystem", views.filesystem);
		ctx.provide("exec", views.exec);
		ctx.provide("process", views.process);
		ctx.provide("ports", views.ports);
	},
});
