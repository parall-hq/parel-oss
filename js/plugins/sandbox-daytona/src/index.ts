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
	type SandboxViewStore,
} from "@parel/capability-sandbox";
import { definePlugin, LifecycleEvent, type ParelPlugin } from "@parel/plugin-sdk";
import manifest from "../parel.plugin.json" with { type: "json" };

const STORE_KEY = "daytona_sandbox_id";
// Process/port records written by the shared capability views. In instance mode
// they describe state inside the shared sandbox, so they must live wherever the
// sandbox lives (the instance store) — sibling sessions have to see them.
const PROCESS_VIEW_STORE_PREFIX = "sandbox_process:";
const PORT_VIEW_STORE_PREFIX = "sandbox_port:";

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
		// An explicitly configured sandboxId means the user manages this sandbox's
		// identity outside PAREL (they pinned a specific machine). In instance mode
		// we connect to it directly and never race, kill, or migrate it — the
		// escape hatch stays externally owned. See the mode dispatch below.
		const externalId = stringConfig(ctx.config.sandboxId);

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
		// sandbox. Only the managed shape runs the CAS/authority/migration machinery.
		const managed = Boolean(istore) && !externalId;

		let client: Daytona | null = null;
		let sandbox: DaytonaSandbox | null = null;
		let cwd: string | undefined;
		let sandboxRecovery: Promise<DaytonaSandbox | null> | null = null;
		// Bumped on teardown so an in-flight recovery can tell its result is stale
		// and must not be published (or leak) after the session ended.
		let sandboxEpoch = 0;

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

		// Create a brand-new sandbox. Does NOT publish any handle — the caller owns
		// where the id is recorded (per-session store vs instance-store cas).
		async function createRawSandbox(): Promise<DaytonaSandbox | null> {
			const daytona = getClient();
			if (!daytona) return null;
			const created = (await daytona.create(buildCreateParams(ctx.config), {
				timeout: createTimeout,
			})) as unknown as DaytonaSandbox;
			cwd = await created.getWorkDir();
			ctx.log.info(`Daytona sandbox created: ${created.id}`);
			return created;
		}

		// Reconnect to an existing sandbox by id or name, starting it if stopped.
		// Returns null (not throw) when it is unreachable so callers can decide to
		// replace it. Does NOT publish any handle.
		async function reconnectSandbox(idOrName: string): Promise<DaytonaSandbox | null> {
			const daytona = getClient();
			if (!daytona) return null;
			try {
				const existing = (await daytona.get(idOrName)) as unknown as DaytonaSandbox;
				if (String(existing.state ?? "").toLowerCase() !== "started") {
					await existing.start(createTimeout);
				}
				cwd = await existing.getWorkDir();
				ctx.log.info(`Daytona sandbox connected: ${existing.id}`);
				return existing;
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				ctx.log.warn(`Failed to connect Daytona sandbox ${idOrName}: ${message}`);
				return null;
			}
		}

		// Best-effort kill by id. Daytona has no kill-by-id primitive, so reconnect
		// then delete the handle. A reconnect failure means it is already gone — we
		// report false (nothing killed) rather than throwing.
		async function killSandboxById(id: string): Promise<boolean> {
			const daytona = getClient();
			if (!daytona) return false;
			try {
				const existing = (await daytona.get(id)) as unknown as DaytonaSandbox;
				await existing.delete(createTimeout);
				return true;
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				ctx.log.warn(`Failed to kill Daytona sandbox ${id}: ${message}`);
				return false;
			}
		}

		// Per-session mode only: create and publish to the session store.
		async function createSandbox(): Promise<DaytonaSandbox | null> {
			const created = await createRawSandbox();
			if (created) await ctx.store.set(STORE_KEY, created.id);
			return created;
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
					ctx.log.info(`Daytona sandbox ${legacy} migrated to the instance store`);
					return;
				}
				// Lost the promotion race — fall through to the orphan check.
			}
			if ((await istore.get<string>(STORE_KEY))?.value !== legacy) {
				await killSandboxById(legacy);
				ctx.log.info(`Daytona legacy sandbox ${legacy} reaped (instance already has a sandbox)`);
			}
			await ctx.store.delete(STORE_KEY);
			await moveLegacyRecords(false);
		}

		// Instance mode (managed): acquire the ONE sandbox shared by every session of
		// this agent instance. The authoritative id lives in the instance store; all
		// mutations go through cas() because sibling sessions' turns race here. The
		// loser of any race kills its own orphan and adopts the winner on the next
		// pass.
		async function acquireSharedSandbox(): Promise<DaytonaSandbox | null> {
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
					// replacement FIRST so a creation failure leaves the old id intact.
					const fresh = await createRawSandbox();
					if (!fresh) return null;
					if (await istore.cas(STORE_KEY, entry.version, fresh.id)) {
						ctx.log.warn(
							`Daytona filesystem reset: sandbox ${entry.value} was unreachable, swapped in ${fresh.id} (files in the previous sandbox are lost)`,
						);
						await killSandboxById(entry.value);
						// The unreachable sandbox took its processes/ports with it — its
						// records would otherwise be read as belonging to the fresh one.
						await clearViewRecords();
						return fresh;
					}
					// A sibling already swapped in its replacement — discard ours.
					await killSandboxById(fresh.id);
					continue;
				}
				const fresh = await createRawSandbox();
				if (!fresh) return null;
				if (await istore.cas(STORE_KEY, null, fresh.id)) return fresh;
				// Lost the cold-start race — exactly one sibling won; use theirs.
				await killSandboxById(fresh.id);
			}
			throw new Error("Daytona sandbox acquisition kept losing instance-store races; giving up");
		}

		// Per-session (and external-pin) acquire: reconnect a configured/stored
		// sandbox if reachable, else create fresh. Publishes to the session store.
		async function acquirePerSession(): Promise<DaytonaSandbox | null> {
			// Externally pinned sandbox (instance mode, config.sandboxId): connect ONLY
			// that id. Never fall back to config.name / a stored id or create a
			// replacement — the pin is the user's, a fresh Daytona sandbox would get a
			// different server-generated id (never reconnected), and instance-mode
			// SessionEnd releases without killing, so any substitute would leak.
			if (istore && externalId) {
				const pinned = await reconnectSandbox(externalId);
				if (pinned) {
					await ctx.store.set(STORE_KEY, pinned.id);
					return pinned;
				}
				throw new Error(
					`Daytona sandbox ${externalId} (config.sandboxId) is unreachable; refusing to substitute or create a replacement for an externally pinned sandbox`,
				);
			}
			// Historical one-sandbox-per-session path, unchanged.
			const configuredId = stringConfig(ctx.config.sandboxId);
			const configuredName = stringConfig(ctx.config.name);
			const savedId = await ctx.store.get<string>(STORE_KEY);
			for (const idOrName of [configuredId, configuredName, savedId]) {
				if (!idOrName) continue;
				const existing = await reconnectSandbox(idOrName);
				if (existing) {
					await ctx.store.set(STORE_KEY, existing.id);
					return existing;
				}
			}
			return createSandbox();
		}

		// Mode dispatch: a managed instance shares one sandbox per agent instance;
		// per-session and external-pin modes keep the connect-or-create behavior.
		function acquire(): Promise<DaytonaSandbox | null> {
			return managed ? acquireSharedSandbox() : acquirePerSession();
		}

		// Tool/capability call path. Lifecycle hooks stay the warm path; this is the
		// fallback for when they were skipped or misfired, so the first tool call
		// self-heals instead of the whole turn failing on a dead sandbox.
		// Single-flight: concurrent calls await one shared recovery. A failed
		// recovery clears the slot so the next call retries rather than caching it.
		async function ensureSandbox(): Promise<DaytonaSandbox | null> {
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
				// "one shared filesystem". One instance-store read per call is cheap
				// next to the sandbox operation itself.
				const authoritative = await istore?.get<string>(STORE_KEY);
				if (authoritative?.value === cached.id) return cached;
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
								throw new Error("Daytona sandbox recovery discarded: session torn down");
							}
							// Per-session mode: nothing else will ever clean it up — reap it
							// (respecting destroyOnSessionEnd) and stay torn down.
							if (s && destroyOnSessionEnd) {
								await killSandboxById(s.id);
								await ctx.store.delete(STORE_KEY);
							}
							throw new Error("Daytona sandbox was torn down during recovery");
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

		async function requireSandbox(): Promise<DaytonaSandbox> {
			const s = await ensureSandbox();
			if (!s) throw new Error("Daytona sandbox not available");
			return s;
		}

		// Drop this session's reference to the shared sandbox WITHOUT killing it: in
		// instance mode the sandbox belongs to the agent instance, and sibling
		// sessions (or the next conversation) keep using it. Daytona's own
		// auto-stop/auto-archive governs its lifetime from here.
		async function releaseSandbox(): Promise<void> {
			sandboxEpoch++;
			if (sandboxRecovery) {
				await sandboxRecovery.catch(() => {});
			}
			sandbox = null;
			cwd = undefined;
		}

		// Explicit destruction (lifecycle.stop, or SessionEnd for an ephemeral
		// instance). In instance mode this kills the INSTANCE's sandbox — only
		// reachable via an explicit stop or an ephemeral teardown, never from a
		// session merely ending.
		async function destroySandbox(): Promise<void> {
			sandboxEpoch++;
			// Settle any in-flight recovery before finishing: after the epoch bump it
			// reaps itself instead of publishing, and awaiting it here means teardown
			// is actually complete when this resolves.
			if (sandboxRecovery) {
				await sandboxRecovery.catch(() => {});
			}
			if (istore) {
				sandbox = null;
				cwd = undefined;
				// An externally pinned sandbox never wrote the instance-store handle, so
				// there is no entry to retire and nothing for PAREL to kill — its
				// lifecycle stays the user's (we only drop our local reference above).
				const entry = await istore.get<string>(STORE_KEY);
				if (entry) {
					// Retire the handle BEFORE killing, and only the exact version we
					// observed: a sibling may be swapping in a replacement right now, and
					// an unconditional delete would erase its fresh id without killing
					// that sandbox (a live orphan). casDelete makes the race explicit — if
					// we lose, the handle now points at a different sandbox and this stop
					// no longer owns the kill.
					const retired = (await istore.casDelete?.(STORE_KEY, entry.version)) ?? false;
					if (!retired && istore.casDelete) {
						ctx.log.warn("Daytona stop skipped: the instance sandbox changed mid-stop");
						await ctx.store.delete(STORE_KEY);
						return;
					}
					if (!istore.casDelete) await istore.delete(STORE_KEY); // legacy host fallback
					if (await killSandboxById(entry.value)) {
						ctx.log.info(`Daytona sandbox destroyed: ${entry.value}`);
					}
					// The retired sandbox took its processes/ports with it — clear their
					// now-ghost records so the next sandbox does not inherit them.
					await clearViewRecords();
				}
				await ctx.store.delete(STORE_KEY);
				return;
			}
			const target = sandbox?.id ?? (await ctx.store.get<string>(STORE_KEY));
			sandbox = null;
			cwd = undefined;
			if (target && (await killSandboxById(target))) {
				ctx.log.info(`Daytona sandbox destroyed: ${target}`);
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
			cwd = undefined;
			if (!current) return;
			if (destroyOnSessionEnd) {
				await current.delete(createTimeout);
				await ctx.store.delete(STORE_KEY);
			} else {
				await current.stop(createTimeout);
			}
		}

		async function runShell(
			command: string,
			opts?: SandboxExecOptions | SandboxShellOptions,
		): Promise<SandboxProcessResult> {
			const current = await requireSandbox();
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
					const s = await requireSandbox();
					const buffer = await s.fs.downloadFile(path, createTimeout);
					const content =
						opts?.encoding === "base64" ? buffer.toString("base64") : buffer.toString("utf8");
					return opts?.maxChars ? limitOutput(content, opts.maxChars) : content;
				},
				async writeFile(path, content, opts) {
					const s = await requireSandbox();
					const buffer = Buffer.from(content, opts?.encoding === "base64" ? "base64" : "utf8");
					await s.fs.uploadFile(buffer, path, createTimeout);
				},
				async listDir(path) {
					const s = await requireSandbox();
					return (await s.fs.listFiles(path)).map(mapFileEntry);
				},
				async stat(path) {
					const s = await requireSandbox();
					return mapFileStat(path, await s.fs.getFileDetails(path));
				},
				async exists(path) {
					const s = await requireSandbox();
					try {
						await s.fs.getFileDetails(path);
						return true;
					} catch {
						return false;
					}
				},
				async mkdir(path) {
					const s = await requireSandbox();
					await s.fs.createFolder(path, "755");
				},
				async remove(path, opts) {
					const s = await requireSandbox();
					await s.fs.deleteFile(path, opts?.recursive);
				},
				async rename(from, to) {
					const s = await requireSandbox();
					await s.fs.moveFiles(from, to);
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
					const s = await requireSandbox();
					const preview = await s.getPreviewLink(port);
					return { port, url: preview.url, protocol: "https", metadata: { token: preview.token } };
				},
			},
			lifecycle: {
				async isRunning() {
					// A pure status query: reports the current state and must not
					// side-effect a sandbox into existence like requireSandbox would.
					if (!sandbox) return false;
					if (sandbox.refreshData) await sandbox.refreshData();
					return String(sandbox.state ?? "started").toLowerCase() === "started";
				},
				async stop() {
					// Instance mode: retire and kill the shared sandbox. Per-session mode
					// keeps its historical stop-only behavior — the sandbox and its files
					// survive for a later reconnect.
					if (istore) {
						await destroySandbox();
						return;
					}
					if (!sandbox) throw new Error("Daytona sandbox not available");
					await sandbox.stop(createTimeout);
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
			cwd = undefined;
			sandbox = await acquire();
		});

		ctx.hook(LifecycleEvent.SessionSuspend, async () => {
			// Instance mode: the authoritative handle is already in the instance store
			// (written at creation/adoption) — nothing to save.
			if (!istore && sandbox) await ctx.store.set(STORE_KEY, sandbox.id);
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
