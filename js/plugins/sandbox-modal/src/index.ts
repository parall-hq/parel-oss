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
	type SandboxViewStore,
} from "@parel/capability-sandbox";
import { definePlugin, LifecycleEvent, type ParelPlugin } from "@parel/plugin-sdk";
import { Image, ModalClient } from "modal";
import manifest from "../parel.plugin.json" with { type: "json" };

const STORE_KEY = "modal_sandbox_id";
// Process/port records written by the shared capability views. In instance mode
// they describe state inside the shared sandbox, so they must live wherever the
// sandbox lives (the instance store) — sibling sessions have to see them.
const PROCESS_VIEW_STORE_PREFIX = "sandbox_process:";
const PORT_VIEW_STORE_PREFIX = "sandbox_port:";

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
		// An explicitly configured sandboxId (a specific machine) or name (Modal's
		// documented reconnect-a-running-named-sandbox path) means the user manages
		// this sandbox's identity outside PAREL. In instance mode we connect to it
		// directly and never race/kill/migrate it — sibling sessions still share it,
		// keyed by that id/name instead of by cas. See the mode dispatch below.
		const externalId = stringConfig(ctx.config.sandboxId) ?? stringConfig(ctx.config.name);

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

		let client: ModalClient | null = null;
		let sandbox: ModalSandbox | null = null;
		let sandboxRecovery: Promise<ModalSandbox | null> | null = null;
		// Bumped on teardown so an in-flight recovery can tell its result is stale
		// and must not be published (or leak) after the session ended.
		let sandboxEpoch = 0;

		function getClient(): ModalClient | null {
			if (!tokenId || !tokenSecret) {
				ctx.log.warn("Modal tokenId and tokenSecret are required");
				return null;
			}
			client ??= new ModalClient({ tokenId, tokenSecret, environment });
			return client;
		}

		// Create a brand-new sandbox inside the app. Does NOT publish any handle —
		// the caller owns where the id is recorded (per-session store vs cas).
		async function createInApp(modal: ModalClient): Promise<ModalSandbox> {
			const app = await modal.apps.fromName(appName, { createIfMissing: true, environment });
			const image = Image.fromRegistry(imageRef);
			const created = (await modal.sandboxes.create(
				app,
				image,
				buildCreateParams(ctx.config),
			)) as ModalSandbox;
			ctx.log.info(`Modal sandbox created: ${created.sandboxId}`);
			return created;
		}

		async function createRawSandbox(): Promise<ModalSandbox | null> {
			const modal = getClient();
			if (!modal) return null;
			return createInApp(modal);
		}

		// Reconnect to an existing sandbox by id. Returns null (not throw) when it is
		// unreachable so the managed acquire can decide to replace it. Does NOT
		// publish any handle.
		async function reconnectById(id: string): Promise<ModalSandbox | null> {
			const modal = getClient();
			if (!modal) return null;
			try {
				const s = (await modal.sandboxes.fromId(id)) as ModalSandbox;
				ctx.log.info(`Modal sandbox connected: ${id}`);
				return s;
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				ctx.log.warn(`Failed to connect Modal sandbox ${id}: ${message}`);
				return null;
			}
		}

		// Best-effort kill by id. Modal terminates via a live handle, so reconnect
		// then terminate. A reconnect failure means it is already gone — we report
		// false (nothing killed) rather than throwing.
		async function killSandboxById(id: string): Promise<boolean> {
			const modal = getClient();
			if (!modal) return false;
			try {
				const s = (await modal.sandboxes.fromId(id)) as ModalSandbox;
				await s.terminate();
				return true;
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				ctx.log.warn(`Failed to kill Modal sandbox ${id}: ${message}`);
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
				const reconnected = await reconnectById(legacy);
				if (!reconnected) {
					// Dead handle — nothing to promote or reap.
					await ctx.store.delete(STORE_KEY);
					await moveLegacyRecords(false);
					return;
				}
				if (await istore.cas(STORE_KEY, null, legacy)) {
					await ctx.store.delete(STORE_KEY);
					await moveLegacyRecords(true);
					ctx.log.info(`Modal sandbox ${legacy} migrated to the instance store`);
					return;
				}
				// Lost the promotion race — fall through to the orphan check.
			}
			if ((await istore.get<string>(STORE_KEY))?.value !== legacy) {
				await killSandboxById(legacy);
				ctx.log.info(`Modal legacy sandbox ${legacy} reaped (instance already has a sandbox)`);
			}
			await ctx.store.delete(STORE_KEY);
			await moveLegacyRecords(false);
		}

		// Instance mode (managed): acquire the ONE sandbox shared by every session of
		// this agent instance. The authoritative id lives in the instance store; all
		// mutations go through cas() because sibling sessions' turns race here. The
		// loser of any race kills its own orphan and adopts the winner on the next
		// pass.
		async function acquireSharedSandbox(): Promise<ModalSandbox | null> {
			if (!istore) throw new Error("acquireSharedSandbox requires an instance store");
			await migrateLegacyHandle();
			for (let attempt = 0; attempt < 3; attempt++) {
				const entry = await istore.get<string>(STORE_KEY);
				if (entry) {
					const reconnected = await reconnectById(entry.value);
					if (reconnected) {
						// A sibling may have swapped the handle while we were
						// reconnecting — the superseded sandbox can still answer before
						// the sibling's terminate lands. Only adopt if it is still
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
					if (await istore.cas(STORE_KEY, entry.version, fresh.sandboxId)) {
						ctx.log.warn(
							`Modal filesystem reset: sandbox ${entry.value} was unreachable, swapped in ${fresh.sandboxId} (files in the previous sandbox are lost)`,
						);
						await killSandboxById(entry.value);
						// The unreachable sandbox took its processes/ports with it — its
						// records would otherwise be read as belonging to the fresh one.
						await clearViewRecords();
						return fresh;
					}
					// A sibling already swapped in its replacement — discard ours.
					await killSandboxById(fresh.sandboxId);
					continue;
				}
				const fresh = await createRawSandbox();
				if (!fresh) return null;
				if (await istore.cas(STORE_KEY, null, fresh.sandboxId)) return fresh;
				// Lost the cold-start race — exactly one sibling won; use theirs.
				await killSandboxById(fresh.sandboxId);
			}
			throw new Error("Modal sandbox acquisition kept losing instance-store races; giving up");
		}

		// Per-session (and external-pin) acquire: reconnect a configured/stored
		// sandbox, connect a named one (creating it on miss), else create fresh.
		// Publishes to the session store. Historical one-sandbox-per-session path.
		async function acquirePerSession(): Promise<ModalSandbox | null> {
			const modal = getClient();
			if (!modal) return null;
			const sandboxId =
				stringConfig(ctx.config.sandboxId) ?? (await ctx.store.get<string>(STORE_KEY));
			let next: ModalSandbox;
			if (sandboxId) {
				next = (await modal.sandboxes.fromId(sandboxId)) as ModalSandbox;
			} else if (stringConfig(ctx.config.name)) {
				try {
					next = (await modal.sandboxes.fromName(appName, stringConfig(ctx.config.name) ?? "", {
						environment,
					})) as ModalSandbox;
				} catch {
					next = await createInApp(modal);
				}
			} else {
				next = await createInApp(modal);
			}
			await ctx.store.set(STORE_KEY, next.sandboxId);
			ctx.log.info(`Modal sandbox ready: ${next.sandboxId}`);
			return next;
		}

		// Mode dispatch: a managed instance shares one sandbox per agent instance;
		// per-session and external-pin modes keep the connect-or-create behavior.
		function acquire(): Promise<ModalSandbox | null> {
			return managed ? acquireSharedSandbox() : acquirePerSession();
		}

		// Tool/capability call path. Lifecycle hooks stay the warm path; this is the
		// fallback for when they were skipped or misfired, so the first tool call
		// self-heals instead of the whole turn failing on a dead sandbox.
		// Single-flight: concurrent calls await one shared recovery. A failed
		// recovery clears the slot so the next call retries rather than caching it.
		async function ensureSandbox(): Promise<ModalSandbox | null> {
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
				if (authoritative?.value === cached.sandboxId) return cached;
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
								throw new Error("Modal sandbox recovery discarded: session torn down");
							}
							// Per-session mode: nothing else will ever clean it up — reap it
							// (respecting destroyOnSessionEnd) and stay torn down.
							if (s && destroyOnSessionEnd) {
								await killSandboxById(s.sandboxId);
								await ctx.store.delete(STORE_KEY);
							}
							throw new Error("Modal sandbox was torn down during recovery");
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

		async function requireSandbox(): Promise<ModalSandbox> {
			const s = await ensureSandbox();
			if (!s) throw new Error("Modal sandbox not available");
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
					// an unconditional delete would erase its fresh id without killing
					// that sandbox (a live orphan). casDelete makes the race explicit — if
					// we lose, the handle now points at a different sandbox and this stop
					// no longer owns the kill.
					const retired = (await istore.casDelete?.(STORE_KEY, entry.version)) ?? false;
					if (!retired && istore.casDelete) {
						ctx.log.warn("Modal stop skipped: the instance sandbox changed mid-stop");
						await ctx.store.delete(STORE_KEY);
						return;
					}
					if (!istore.casDelete) await istore.delete(STORE_KEY); // legacy host fallback
					if (await killSandboxById(entry.value)) {
						ctx.log.info(`Modal sandbox destroyed: ${entry.value}`);
					}
					// The retired sandbox took its processes/ports with it — clear their
					// now-ghost records so the next sandbox does not inherit them.
					await clearViewRecords();
				}
				await ctx.store.delete(STORE_KEY);
				return;
			}
			const target = sandbox?.sandboxId ?? (await ctx.store.get<string>(STORE_KEY));
			sandbox = null;
			if (target && (await killSandboxById(target))) {
				ctx.log.info(`Modal sandbox destroyed: ${target}`);
			}
			await clearViewRecords();
			await ctx.store.delete(STORE_KEY);
		}

		// Per-session SessionEnd: honor destroyOnSessionEnd (terminate vs detach).
		// Kept byte-identical to the historical behavior.
		async function disposeSandbox(): Promise<void> {
			sandboxEpoch++;
			if (sandboxRecovery) {
				await sandboxRecovery.catch(() => {});
			}
			const current = sandbox;
			sandbox = null;
			if (!current) return;
			if (destroyOnSessionEnd) {
				await current.terminate();
				await ctx.store.delete(STORE_KEY);
			} else {
				current.detach();
			}
		}

		async function execCommand(
			command: SandboxCommand,
			opts?: SandboxExecOptions,
		): Promise<SandboxProcessResult> {
			const s = await requireSandbox();
			const process = await s.exec([...command], {
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
			const s = await requireSandbox();
			const process = await s.exec([shell, "-lc", command], {
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
					const s = await requireSandbox();
					if (opts?.encoding === "base64") {
						return Buffer.from(await s.filesystem.readBytes(path)).toString("base64");
					}
					const content = await s.filesystem.readText(path);
					return opts?.maxChars ? limitOutput(content, opts.maxChars) : content;
				},
				async writeFile(path, content, opts) {
					const s = await requireSandbox();
					if (opts?.encoding === "base64") {
						await s.filesystem.writeBytes(Buffer.from(content, "base64"), path);
					} else {
						await s.filesystem.writeText(content, path);
					}
				},
				async listDir(path) {
					const s = await requireSandbox();
					return (await s.filesystem.listFiles(path)).map(mapFileEntry);
				},
				async stat(path) {
					const s = await requireSandbox();
					return mapFileStat(path, await s.filesystem.stat(path));
				},
				async exists(path) {
					const s = await requireSandbox();
					try {
						await s.filesystem.stat(path);
						return true;
					} catch {
						return false;
					}
				},
				async mkdir(path, opts) {
					const s = await requireSandbox();
					await s.filesystem.makeDirectory(path, { createParents: opts?.recursive ?? true });
				},
				async remove(path, opts) {
					const s = await requireSandbox();
					await s.filesystem.remove(path, { recursive: opts?.recursive });
				},
			},
			process: {
				exec: execCommand,
				shell: shellCommand,
			},
			ports: {
				async expose(port) {
					const s = await requireSandbox();
					const tunnels = await s.tunnels(numberConfig(ctx.config.tunnelTimeoutMs));
					const tunnel = tunnels[port];
					if (!tunnel) throw new Error(`Modal tunnel for port ${port} is not available`);
					return { port, url: tunnel.url, protocol: "https" };
				},
			},
			lifecycle: {
				async isRunning() {
					// A pure status query: reports the current state and must not
					// side-effect a sandbox into existence like requireSandbox would.
					return sandbox !== null;
				},
				async stop() {
					// Instance mode: retire and kill the shared sandbox. Per-session mode
					// keeps its historical behavior — Modal's stop has always terminated.
					if (istore) {
						await destroySandbox();
						return;
					}
					if (!sandbox) throw new Error("Modal sandbox not available");
					await sandbox.terminate();
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
			if (!istore && sandbox) await ctx.store.set(STORE_KEY, sandbox.sandboxId);
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
