import { CommandExitError, type CommandResult, Sandbox } from "@e2b/code-interpreter";
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

/**
 * e2b SDK 2.x throws `CommandExitError` on any non-zero exit (1.x returned the
 * result), and the error message is an unhelpful "exit status N". Every
 * foreground caller here wants the 1.x contract back — a failing command is a
 * RESULT the agent should see (stderr, exit code), not a tool crash.
 * `CommandExitError` implements `CommandResult`, so the error object itself is
 * the result. Anything else (timeouts, disconnects) still throws.
 */
async function runToResult(run: Promise<CommandResult>): Promise<CommandResult> {
	try {
		return await run;
	} catch (err) {
		if (err instanceof CommandExitError) return err;
		throw err;
	}
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
		// Persistence: when enabled, the sandbox auto-PAUSES on timeout instead
		// of being killed — the filesystem survives across turns/sessions and
		// the existing reconnect path (`Sandbox.connect`) transparently resumes
		// it. Off by default: paused snapshots are retained by E2B indefinitely
		// (storage accrues until `kill()`), so opting in is a billing decision.
		// `timeout` then means "idle time before pause", not time-to-death.
		const persistence = ctx.config.persistence === true;
		// keepMemory=false (default) stores a filesystem-only snapshot: resume
		// cold-boots from disk (processes/connections are NOT restored), which
		// is cheaper to store and the honest contract for per-turn execution.
		// Set true to snapshot memory too (warm resume, larger snapshot).
		const keepMemory = ctx.config.keepMemory === true;

		const apiKey = ctx.config.apiKey as string | undefined;
		// Sandbox-level env vars injected at cold-start, persistent across every
		// command in the sandbox (no per-command prefix needed) — lets the host
		// hand the in-sandbox process its credentials/config at boot time.
		const envs = (ctx.config.env as Record<string, string> | undefined) ?? {};

		// Instance-scoped state (docs/agent-instance-model.md §4.3): when the host
		// provides ctx.instanceStore, the sandbox belongs to the AGENT INSTANCE —
		// every session of the instance shares one sandbox, a conversation reset
		// keeps it, and ending one session must not kill it. On hosts without
		// instance storage (istore === undefined) behavior stays exactly
		// per-session — explicit probing, no silent downgrade of the sharing
		// promise. Captured here; hooks/tools reach it by closure.
		const istore = ctx.instanceStore;
		// Process/port records live wherever the sandbox lives: they describe
		// state inside the shared machine, so sibling sessions must see them.
		const state = istore
			? {
					async get<T>(key: string): Promise<T | null> {
						return (await istore.get<T>(key))?.value ?? null;
					},
					set<T>(key: string, value: T): Promise<void> {
						return istore.set(key, value);
					},
					delete(key: string): Promise<void> {
						return istore.delete(key);
					},
					list(prefix?: string): Promise<string[]> {
						return istore.list(prefix);
					},
				}
			: ctx.store;
		let sandbox: Sandbox | null = null;
		let sandboxRecovery: Promise<Sandbox> | null = null;
		// Bumped on teardown so an in-flight recovery can tell its result is
		// stale and must not be published (or leak) after the session ended.
		let sandboxEpoch = 0;

		async function createRawSandbox(): Promise<Sandbox> {
			if (!apiKey) {
				// A missing key is a deployment/config error: fail loudly and early.
				// Silently skipping creation here used to let the whole session run
				// with every sandbox tool broken, surfacing only as a generic
				// "not available" at tool-call time.
				throw new Error(
					'E2B API key not provided — set the "apiKey" secret for @parel/sandbox-e2b',
				);
			}
			let s: Sandbox;
			try {
				s = await Sandbox.create(template, {
					timeoutMs: timeout,
					apiKey,
					envs,
					...(persistence
						? { lifecycle: { onTimeout: { action: "pause" as const, keepMemory } } }
						: {}),
				});
			} catch (err: unknown) {
				const msg = err instanceof Error ? err.message : "Unknown error";
				throw new Error(`Failed to create E2B sandbox: ${msg}`, { cause: err });
			}
			ctx.log.info(
				`E2B sandbox created: ${s.sandboxId}${persistence ? " (persistent: pause-on-timeout)" : ""}`,
			);
			return s;
		}

		// Per-session mode only: create and publish to the session store.
		async function createSandbox(): Promise<Sandbox> {
			const s = await createRawSandbox();
			await ctx.store.set(STORE_KEY, s.sandboxId);
			return s;
		}

		async function reconnectSandbox(sandboxId: string): Promise<Sandbox | null> {
			// For a PAUSED sandbox (persistence mode) connect() transparently
			// resumes it — with keepMemory=false that's a cold boot from the
			// filesystem snapshot (a few seconds), with keepMemory=true a warm
			// ~1s memory restore. Giving up swaps in a blank filesystem (see
			// acquireSandbox), so retry once: a transient network blip must not
			// cost the user their files.
			for (let attempt = 1; attempt <= 2; attempt++) {
				try {
					const s = await Sandbox.connect(sandboxId, { apiKey });
					ctx.log.info(`Reconnected to E2B sandbox: ${sandboxId}`);
					return s;
				} catch (err: unknown) {
					const msg = err instanceof Error ? err.message : "Unknown error";
					ctx.log.warn(
						`Failed to reconnect to sandbox ${sandboxId} (attempt ${attempt}/2): ${msg}`,
					);
				}
			}
			return null;
		}

		async function killSandboxById(sandboxId: string): Promise<boolean> {
			try {
				await Sandbox.kill(sandboxId, { apiKey });
				return true;
			} catch (err: unknown) {
				const msg = err instanceof Error ? err.message : "Unknown error";
				ctx.log.warn(`Failed to kill E2B sandbox ${sandboxId}: ${msg}`);
				return false;
			}
		}

		// One-time migration sweep for a pre-instance-mode session: a legacy
		// per-session handle either becomes the instance's authoritative sandbox
		// (files survive the upgrade), or — when a sibling's sandbox already
		// holds authority — it is an orphan that MUST be reaped: nothing else
		// ever references it, and a paused snapshot would be billed forever.
		// Runs before every acquire; a missing legacy key makes it free.
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
					return;
				}
				if (await istore.cas(STORE_KEY, null, legacy)) {
					await ctx.store.delete(STORE_KEY);
					ctx.log.info(`E2B sandbox ${legacy} migrated to the instance store`);
					return;
				}
				// Lost the promotion race — fall through to the orphan check.
			}
			if ((await istore.get<string>(STORE_KEY))?.value !== legacy) {
				await killSandboxById(legacy);
				ctx.log.info(`E2B legacy sandbox ${legacy} reaped (instance already has a sandbox)`);
			}
			await ctx.store.delete(STORE_KEY);
		}

		// Instance mode: acquire the ONE sandbox shared by every session of this
		// agent instance. The authoritative handle lives in the instance store;
		// all mutations go through cas() because sibling sessions' turns race
		// here (two cold starts, or two sessions replacing an unreachable
		// sandbox). The loser of any race kills its own orphan and adopts the
		// winner's sandbox on the next pass.
		async function acquireSharedSandbox(): Promise<Sandbox> {
			if (!istore) throw new Error("acquireSharedSandbox requires an instance store");
			await migrateLegacyHandle();
			for (let attempt = 0; attempt < 3; attempt++) {
				const entry = await istore.get<string>(STORE_KEY);
				if (entry) {
					const reconnected = await reconnectSandbox(entry.value);
					if (reconnected) {
						// A sibling may have swapped the handle while we were
						// reconnecting — the superseded sandbox can still answer
						// connect() before the sibling's kill lands. Only adopt the
						// handle if it is still authoritative; otherwise retry
						// against the current one.
						const current = await istore.get<string>(STORE_KEY);
						if (current?.value === entry.value) return reconnected;
						continue;
					}
					// Authoritative sandbox unreachable — replace it, guarded by the
					// observed version so only one sibling wins the swap. Create the
					// replacement FIRST (see the per-session path for why).
					const fresh = await createRawSandbox();
					if (await istore.cas(STORE_KEY, entry.version, fresh.sandboxId)) {
						ctx.log.warn(
							`E2B filesystem reset: sandbox ${entry.value} was unreachable, swapped in ${fresh.sandboxId} (files in the previous sandbox are lost)`,
						);
						await killSandboxById(entry.value);
						return fresh;
					}
					// A sibling already swapped in its replacement — discard ours.
					await killSandboxById(fresh.sandboxId);
					continue;
				}
				const fresh = await createRawSandbox();
				if (await istore.cas(STORE_KEY, null, fresh.sandboxId)) return fresh;
				// Lost the cold-start race — exactly one sibling won; use theirs.
				await killSandboxById(fresh.sandboxId);
			}
			throw new Error("E2B sandbox acquisition kept losing instance-store races; giving up");
		}

		// Reconnect to the stored sandbox if there is one, else create fresh.
		// Shared by the SessionResume warm path and the ensureSandbox fallback.
		// Per-session mode only; instance mode uses acquireSharedSandbox.
		async function acquireSandbox(): Promise<Sandbox> {
			const savedId = await ctx.store.get<string>(STORE_KEY);
			if (savedId) {
				const reconnected = await reconnectSandbox(savedId);
				if (reconnected) return reconnected;
				// The stored sandbox is unreachable — swap in a fresh one. Order
				// matters: create the replacement FIRST. If creation fails (quota,
				// outage) the store still points at the old snapshot, so a later
				// attempt can reconnect once E2B recovers instead of having killed
				// the user's files with nothing to replace them. Only once the
				// replacement exists is the old sandbox reaped (best-effort) so its
				// paused snapshot doesn't leak storage: after STORE_KEY is
				// overwritten nothing else would ever kill it.
				const fresh = await createSandbox();
				ctx.log.warn(
					`E2B filesystem reset: sandbox ${savedId} was unreachable, swapped in ${fresh.sandboxId} (files in the previous sandbox are lost)`,
				);
				await killSandboxById(savedId);
				return fresh;
			}
			return createSandbox();
		}

		// Mode dispatch: instance mode shares one sandbox per agent instance,
		// per-session mode keeps the historical one-sandbox-per-session behavior.
		function acquire(): Promise<Sandbox> {
			return istore ? acquireSharedSandbox() : acquireSandbox();
		}

		// Tool/capability call path. Lifecycle hooks stay the warm path; this is
		// the fallback for when they were skipped or misfired, so the first tool
		// call self-heals instead of the whole turn failing on a dead sandbox.
		// Single-flight: concurrent tool calls await one shared recovery instead
		// of racing N sandbox creations. A failed recovery clears the slot so the
		// next call retries rather than caching the failure.
		async function ensureSandbox(): Promise<Sandbox> {
			// Capture the cached handle BEFORE any await: two concurrent tool
			// calls can enter this block together, and the first to notice a
			// stale handle nulls the shared `sandbox` — the second must compare
			// against its own captured reference, not re-read the mutated slot.
			const cached = sandbox;
			if (cached) {
				if (!istore) return cached;
				// Instance mode: a sibling session may have replaced the shared
				// sandbox (unreachable → swap). A cached local handle would keep
				// this session on the dead machine forever, silently splitting the
				// instance's "one shared filesystem". One instance-store read per
				// tool call is cheap next to the sandbox operation itself.
				const authoritative = await istore.get<string>(STORE_KEY);
				if (authoritative?.value === cached.sandboxId) return cached;
				if (sandbox === cached) sandbox = null; // stale — re-acquire below
			}
			if (!sandboxRecovery) {
				const epoch = sandboxEpoch;
				sandboxRecovery = acquire()
					.then(async (s) => {
						if (epoch !== sandboxEpoch) {
							// The session tore down while this recovery was in flight.
							if (istore) {
								// Instance mode: the acquired sandbox is (or just became)
								// the instance's shared sandbox — sibling sessions own it
								// too, so just drop our reference. Any orphan we created
								// and lost a race with was already reaped inside
								// acquireSharedSandbox.
								throw new Error("E2B sandbox recovery discarded: session torn down");
							}
							// Per-session mode: nothing else will ever clean it up —
							// reap it and stay torn down instead.
							await killSandboxById(s.sandboxId);
							await ctx.store.delete(STORE_KEY);
							throw new Error("E2B sandbox was torn down during recovery");
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

		// Drop this session's reference to the shared sandbox WITHOUT killing it:
		// in instance mode the sandbox belongs to the agent instance, and sibling
		// sessions (or the next conversation) keep using it. E2B's own idle
		// timeout / pause-on-timeout governs its lifetime from here.
		async function releaseSandbox(): Promise<void> {
			sandboxEpoch++;
			if (sandboxRecovery) {
				await sandboxRecovery.catch(() => {});
			}
			sandbox = null;
		}

		// Explicit destruction (per-session SessionEnd, or the lifecycle.stop
		// capability). In instance mode this kills the INSTANCE's sandbox — only
		// reachable via an explicit stop request, never from a session merely
		// ending.
		async function destroySandbox(): Promise<void> {
			sandboxEpoch++;
			// Settle any in-flight recovery before finishing: after the epoch bump
			// it reaps itself instead of publishing, and awaiting it here means
			// teardown is actually complete when this resolves — no orphan
			// continuation left behind to leak a late sandbox (host may dispose
			// the runtime) or delete a successor session's stored id.
			if (sandboxRecovery) {
				await sandboxRecovery.catch(() => {});
			}
			// Resolve the target from the live handle or the stored id — a session
			// can end while only the store knows the sandbox (hooks misfired), and
			// a paused snapshot would otherwise be retained (and billed) forever.
			if (istore) {
				sandbox = null;
				const entry = await istore.get<string>(STORE_KEY);
				if (entry) {
					// Retire the handle BEFORE killing, and only the exact version we
					// observed: a sibling may be swapping in a replacement right now,
					// and an unconditional delete would erase its fresh id without
					// killing that sandbox (a live orphan). casDelete makes the race
					// explicit — if we lose, the handle now points at a different
					// sandbox and this stop no longer owns the kill.
					const retired = (await istore.casDelete?.(STORE_KEY, entry.version)) ?? false;
					if (!retired && istore.casDelete) {
						ctx.log.warn("E2B stop skipped: the instance sandbox changed mid-stop");
						await ctx.store.delete(STORE_KEY);
						return;
					}
					if (!istore.casDelete) await istore.delete(STORE_KEY); // legacy host fallback
					if (await killSandboxById(entry.value)) {
						ctx.log.info(`E2B sandbox destroyed: ${entry.value}`);
					}
				}
				await ctx.store.delete(STORE_KEY);
				return;
			}
			const sandboxId = sandbox?.sandboxId ?? (await ctx.store.get<string>(STORE_KEY));
			sandbox = null;
			if (sandboxId && (await killSandboxById(sandboxId))) {
				ctx.log.info(`E2B sandbox destroyed: ${sandboxId}`);
			}
			await ctx.store.delete(STORE_KEY);
		}

		// --- Lifecycle hooks ---

		ctx.hook(LifecycleEvent.SessionStart, async () => {
			// Instance mode: adopt the instance's existing sandbox instead of
			// unconditionally creating one — this is where sibling sessions start
			// sharing a machine.
			sandbox = istore ? await acquire() : await createSandbox();
		});

		ctx.hook(LifecycleEvent.SessionEnd, async () => {
			// Instance mode: the conversation ends, the entity lives on — EXCEPT
			// for an ephemeral instance (try-run/replay), which dies with the
			// session: its store is discarded, so nothing could ever stop the
			// sandbox later, and a persistence-mode paused snapshot would be
			// billed indefinitely.
			if (istore && !ctx.instance?.ephemeral) await releaseSandbox();
			else await destroySandbox();
		});

		ctx.hook(LifecycleEvent.SessionSuspend, async () => {
			// Instance mode: the authoritative handle is already in the instance
			// store (written at creation/adoption) — nothing to save.
			if (!istore && sandbox) {
				await ctx.store.set(STORE_KEY, sandbox.sandboxId);
				ctx.log.info(`Sandbox ID saved for resume: ${sandbox.sandboxId}`);
			}
		});

		ctx.hook(LifecycleEvent.SessionResume, async () => {
			// Reconnect unconditionally: a stale in-memory handle may point at a
			// sandbox that has since paused, and connect() is what resumes it.
			// Clear the handle first — if the resume fails entirely, a lingering
			// stale handle would satisfy ensureSandbox forever and block the
			// self-healing retry; null lets the next tool call recover.
			sandbox = null;
			sandbox = await acquire();
		});

		// --- Capabilities ---

		const filesystem = {
			async readFile(path: string): Promise<string> {
				const s = await ensureSandbox();
				return s.files.read(path);
			},
			async writeFile(path: string, content: string): Promise<void> {
				const s = await ensureSandbox();
				await s.files.write(path, content);
			},
			async exists(path: string): Promise<boolean> {
				// ensureSandbox stays outside the try: an unavailable sandbox is an
				// error worth surfacing, only a failed read means "does not exist".
				const s = await ensureSandbox();
				try {
					await s.files.read(path);
					return true;
				} catch {
					return false;
				}
			},
			async listDir(path: string): Promise<string[]> {
				const s = await ensureSandbox();
				const entries = await s.files.list(path);
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
				const s = await ensureSandbox();
				const turnEnv = invocationEnv(invocation);
				// E2B per-command `envs` shadow the sandbox's cold-start envs, so merge the
				// configured sandbox env (`config.env`) underneath the per-turn values — the
				// per-turn invocation context wins on key conflicts.
				const commandEnv = turnEnv ? { ...envs, ...turnEnv } : undefined;
				const result = await runToResult(
					commandEnv ? s.commands.run(command, { envs: commandEnv }) : s.commands.run(command),
				);
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
			const s = await ensureSandbox();
			const result = await runToResult(s.commands.run(applyShellOptions(command, opts)));
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
					const s = await ensureSandbox();
					const content = await s.files.read(path);
					if (opts?.maxChars && content.length > opts.maxChars)
						return content.slice(0, opts.maxChars);
					return content;
				},
				async writeFile(path, content) {
					const s = await ensureSandbox();
					await s.files.write(path, content);
				},
				async exists(path) {
					return filesystem.exists(path);
				},
				async listDir(path) {
					const s = await ensureSandbox();
					const entries = await s.files.list(path);
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
					// A pure status query: reports the current state and must not
					// side-effect a sandbox into existence like ensureSandbox would.
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
				const s = await ensureSandbox();
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
				await state.set(storeKey(PROCESS_STORE_PREFIX, id), record);
				await handle.disconnect().catch((err: unknown) => {
					const msg = err instanceof Error ? err.message : "Unknown error";
					ctx.log.warn(`Failed to disconnect from background command ${id}: ${msg}`);
				});
				return record;
			},
			async list() {
				const s = await ensureSandbox();
				const keys = await state.list(PROCESS_STORE_PREFIX);
				const records = (
					await Promise.all(keys.map((key) => state.get<SandboxProcessHandle>(key)))
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
				const s = await ensureSandbox();
				const record = await state.get<SandboxProcessHandle>(
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
				const s = await ensureSandbox();
				const record = await state.get<SandboxProcessHandle>(
					storeKey(PROCESS_STORE_PREFIX, processId),
				);
				if (!record) throw new Error(`unknown process: ${processId}`);
				const stopped = await s.commands.kill(record.pid);
				const next: SandboxProcessHandle = { ...record, status: "stopped" };
				await state.set(storeKey(PROCESS_STORE_PREFIX, processId), next);
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
				const s = await ensureSandbox();
				const host = s.getHost(normalizedPort);
				const handle: SandboxPortHandle = {
					id: String(normalizedPort),
					port: normalizedPort,
					host,
					protocol,
					url: portUrl(host, protocol),
					createdAt: new Date().toISOString(),
				};
				await state.set(storeKey(PORT_STORE_PREFIX, handle.id), handle);
				return handle;
			},
			async list() {
				const keys = await state.list(PORT_STORE_PREFIX);
				return (await Promise.all(keys.map((key) => state.get<SandboxPortHandle>(key)))).filter(
					(record): record is SandboxPortHandle => Boolean(record),
				);
			},
			async revoke(port) {
				const normalizedPort = positiveInt(port, 0, 65_535);
				const key = storeKey(PORT_STORE_PREFIX, String(normalizedPort));
				const existing = await state.get<SandboxPortHandle>(key);
				if (!existing) return false;
				await state.delete(key);
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
