import { definePlugin, type ToolContentRef, type ToolOutput } from "@parel/plugin-sdk";

export const WORKSPACE_CAPABILITY = "workspace";
export const WORKSPACE_OWNER_PLUGIN = "@parel/workspace";

const STORE_KEY = "current";

export type WorkspaceExportKind = "archive" | "patch" | "diff";

export interface ExecCapability {
	run(command: string): Promise<string>;
}

interface WorkspaceConfig {
	/** Optional session-local workspace id used for refs and diagnostics. */
	workspaceId?: string;
	/** Plugin-owned workspace identity, for example a git repository. */
	identity?: Record<string, unknown>;
	metadata?: Record<string, unknown>;
	/** Known materialized root, usually supplied by config or a provider plugin. */
	root?: string;
	/** Base directory used when a git workspace identity has no explicit root. */
	baseDir?: string;
	/** Optional git branch used when the identity does not specify one. */
	branch?: string;
	/** Optional git ref used when the identity does not specify one. */
	ref?: string;
	/** Depth for git clone/fetch materialization. */
	cloneDepth?: number;
}

export interface WorkspaceHandle {
	id: string;
	identity: Record<string, unknown>;
	metadata: Record<string, unknown>;
	root?: string;
}

export interface WorkspaceCapability {
	current(): Promise<WorkspaceHandle | null>;
	materialize(opts?: { force?: boolean }): Promise<{ root: string }>;
	root(): Promise<string>;
	export(opts: { kind: WorkspaceExportKind }): Promise<{ ref: ToolContentRef }>;
	metadata(): Promise<Record<string, unknown>>;
}

function stableStringify(value: unknown): string {
	if (!value || typeof value !== "object" || Array.isArray(value)) return JSON.stringify(value);
	const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
		a.localeCompare(b),
	);
	return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

function hashKey(input: string): string {
	let hash = 5381;
	for (let i = 0; i < input.length; i++) {
		hash = ((hash << 5) + hash + input.charCodeAt(i)) | 0;
	}
	return (hash >>> 0).toString(36);
}

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asPositiveInt(value: unknown, fallback: number, max: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	const normalized = Math.floor(value);
	if (normalized < 1) return 1;
	if (normalized > max) return max;
	return normalized;
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}

function stripTrailingSlash(value: string): string {
	const stripped = value.replace(/\/+$/, "");
	return stripped.length > 0 ? stripped : "/";
}

function safeSegment(value: string): string {
	const normalized = value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
	return normalized.length > 0 ? normalized.slice(0, 80) : "workspace";
}

function repoSlug(repo: string): string {
	const withoutQuery = repo.split(/[?#]/)[0] ?? repo;
	const last = withoutQuery.replace(/\/+$/, "").split(/[/:]/).pop() ?? "repo";
	return safeSegment(last.replace(/\.git$/, "")) || "repo";
}

function gitRepoFromIdentity(identity: Record<string, unknown>): string | undefined {
	const sourceKind = asString(identity.sourceKind);
	const repo = asString(identity.repo) ?? asString(identity.repository) ?? asString(identity.url);
	if (!repo) return undefined;
	if (sourceKind && sourceKind !== "git" && !sourceKind.startsWith("git:")) return undefined;
	return repo;
}

function defaultRootForRepo(repo: string, config: WorkspaceConfig): string {
	const baseDir = stripTrailingSlash(asString(config.baseDir) ?? "/workspace");
	return `${baseDir}/${repoSlug(repo)}-${hashKey(repo)}`;
}

function gitBranch(handle: WorkspaceHandle, config: WorkspaceConfig): string | undefined {
	return (
		asString(handle.identity.branch) ?? asString(handle.metadata.branch) ?? asString(config.branch)
	);
}

function gitRef(handle: WorkspaceHandle, config: WorkspaceConfig): string | undefined {
	return asString(handle.identity.ref) ?? asString(handle.metadata.ref) ?? asString(config.ref);
}

function requireExec(ctx: { require<T = unknown>(name: string): T }): ExecCapability {
	try {
		return ctx.require<ExecCapability>("exec");
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`Workspace materialization/export requires an exec capability: ${message}`);
	}
}

function materializeCommand(opts: {
	repo: string;
	root: string;
	branch?: string;
	ref?: string;
	depth: number;
}): string {
	const script = [
		"set -eu",
		`repo=${shellQuote(opts.repo)}`,
		`root=${shellQuote(opts.root)}`,
		`branch=${shellQuote(opts.branch ?? "")}`,
		`ref=${shellQuote(opts.ref ?? "")}`,
		`depth=${opts.depth}`,
		'mkdir -p "$(dirname "$root")"',
		'if [ -d "$root/.git" ]; then',
		'  cd "$root"',
		'  git remote set-url origin "$repo" >/dev/null 2>&1 || true',
		"  git fetch --all --prune --tags",
		'  if [ -n "$branch" ]; then git checkout "$branch"; git pull --ff-only || true; fi',
		"else",
		'  rm -rf "$root"',
		'  if [ -n "$branch" ]; then',
		'    git clone --depth "$depth" --branch "$branch" "$repo" "$root"',
		"  else",
		'    git clone --depth "$depth" "$repo" "$root"',
		"  fi",
		'  cd "$root"',
		"fi",
		'if [ -n "$ref" ]; then git fetch --depth "$depth" origin "$ref" >/dev/null 2>&1 || true; git checkout "$ref"; fi',
		'printf "\\n__PAREL_WORKSPACE_OK__:%s\\n" "$root"',
	].join("\n");
	return `sh -lc ${shellQuote(script)}`;
}

function exportCommand(root: string, kind: WorkspaceExportKind, outputPath: string): string {
	const script = [
		"set -eu",
		`root=${shellQuote(root)}`,
		`outfile=${shellQuote(outputPath)}`,
		'mkdir -p "$(dirname "$outfile")"',
		'cd "$root"',
		kind === "archive"
			? 'tar -czf "$outfile" .'
			: kind === "patch"
				? 'git diff --binary --full-index -- . > "$outfile"'
				: 'git diff -- . > "$outfile"',
		'printf "\\n__PAREL_WORKSPACE_EXPORT__:%s\\n" "$outfile"',
	].join("\n");
	return `sh -lc ${shellQuote(script)}`;
}

function exportRefFor(
	handle: WorkspaceHandle,
	kind: WorkspaceExportKind,
	root: string,
): ToolContentRef {
	const dir = `/tmp/parel/workspaces/${safeSegment(handle.id)}`;
	const filename =
		kind === "archive" ? "workspace.tgz" : kind === "patch" ? "workspace.patch" : "workspace.diff";
	const mediaType =
		kind === "archive" ? "application/gzip" : kind === "patch" ? "text/x-patch" : "text/x-diff";
	return {
		type: "sandbox_path",
		path: `${dir}/${filename}`,
		mediaType,
		metadata: { kind, workspaceId: handle.id, root },
	};
}

function normalizeHandle(value: unknown): WorkspaceHandle | null {
	const record = asRecord(value);
	const metadata = asRecord(record.metadata);
	const identity = asRecord(record.identity);
	const root =
		asString(record.root) ??
		asString(metadata.root) ??
		asString(metadata.rootPath) ??
		asString(metadata.materializedRoot);
	const id = asString(record.id);
	if (!id) return null;
	return {
		id,
		identity,
		metadata: {
			...metadata,
			...(root ? { root } : {}),
		},
		...(root ? { root } : {}),
	};
}

function configuredHandle(config: WorkspaceConfig): WorkspaceHandle | null {
	if (!config.identity && !config.root && !config.metadata) return null;
	const identity = config.identity ?? {};
	const metadata = {
		...(config.metadata ?? {}),
		...(config.root ? { root: config.root } : {}),
	};
	const id =
		config.workspaceId ??
		`ws_${hashKey(stableStringify({ identity, metadata, root: config.root ?? null }))}`;
	return normalizeHandle({ id, identity, metadata, root: config.root });
}

export default definePlugin({
	name: WORKSPACE_OWNER_PLUGIN,
	version: "0.1.0",
	provides: { tools: true, capabilities: [WORKSPACE_CAPABILITY] },

	async setup(ctx) {
		const config = (ctx.config ?? {}) as WorkspaceConfig;

		// Instance mode (docs/agent-instance-model.md §4.3): the workspace handle
		// describes state inside the instance's SHARED sandbox (materialized root,
		// branch), so it must live at the same layer as the sandbox itself. Every
		// session of the instance reads the authoritative handle per call (no
		// local cache — a sibling may materialize between our turns) and saves
		// via cas: losing means a sibling saved first, and since siblings run the
		// same config their handle is the one to adopt. Filesystem-level races
		// (two concurrent clones) are left to the idempotent materialize script —
		// the loser's next attempt lands on the fetch path.
		const istore = ctx.instanceStore;
		// Per-session mode only.
		let cached: WorkspaceHandle | null | undefined;
		// cas token: version observed by the latest instance-store read.
		let lastSeenVersion: number | null = null;

		const save = async (handle: WorkspaceHandle): Promise<WorkspaceHandle> => {
			const normalized = normalizeHandle(handle) ?? handle;
			if (istore) {
				if (await istore.cas(STORE_KEY, lastSeenVersion, normalized)) {
					const entry = await istore.get<WorkspaceHandle>(STORE_KEY);
					lastSeenVersion = entry?.version ?? null;
					return normalized;
				}
				// A sibling saved first — adopt the authoritative handle.
				const entry = await istore.get<WorkspaceHandle>(STORE_KEY);
				lastSeenVersion = entry?.version ?? null;
				return normalizeHandle(entry?.value) ?? normalized;
			}
			await ctx.store.set(STORE_KEY, normalized);
			cached = normalized;
			return normalized;
		};

		const current = async (): Promise<WorkspaceHandle | null> => {
			if (istore) {
				const entry = await istore.get<WorkspaceHandle>(STORE_KEY);
				lastSeenVersion = entry?.version ?? null;
				const stored = normalizeHandle(entry?.value);
				if (stored) return stored;
				// One-time migration: promote a pre-instance-mode per-session
				// handle so an already-materialized root survives the upgrade.
				const legacy = normalizeHandle(await ctx.store.get(STORE_KEY));
				if (legacy) {
					const adopted = await save(legacy);
					await ctx.store.delete(STORE_KEY);
					return adopted;
				}
				const configured = configuredHandle(config);
				return configured ? await save(configured) : null;
			}
			if (cached !== undefined) return cached;
			const stored = normalizeHandle(await ctx.store.get(STORE_KEY));
			if (stored) {
				cached = stored;
				return cached;
			}
			const configured = configuredHandle(config);
			cached = configured ? await save(configured) : null;
			return cached;
		};

		const workspace: WorkspaceCapability = {
			current,
			async materialize(opts = {}) {
				const handle = await current();
				if (!handle) {
					throw new Error("No workspace is configured for this session");
				}
				const repo = gitRepoFromIdentity(handle.identity);
				if (handle.root && (!opts.force || !repo)) {
					return { root: handle.root };
				}
				if (!repo) {
					throw new Error("Workspace is not materialized: no root is available");
				}
				const root = stripTrailingSlash(handle.root ?? defaultRootForRepo(repo, config));
				const exec = requireExec(ctx);
				const branch = gitBranch(handle, config);
				const ref = gitRef(handle, config);
				const depth = asPositiveInt(config.cloneDepth, 1, 10_000);
				const output = await exec.run(materializeCommand({ repo, root, branch, ref, depth }));
				if (!output.includes(`__PAREL_WORKSPACE_OK__:${root}`)) {
					throw new Error(`Workspace materialization failed:\n${output}`);
				}
				await save({
					...handle,
					root,
					metadata: {
						...handle.metadata,
						root,
						materializedAt: new Date().toISOString(),
						materializedBy: WORKSPACE_OWNER_PLUGIN,
						...(branch ? { branch } : {}),
						...(ref ? { ref } : {}),
					},
				});
				return { root };
			},
			async root() {
				return (await workspace.materialize()).root;
			},
			async export(opts) {
				const handle = await current();
				if (!handle) {
					throw new Error("No workspace is configured for this session");
				}
				const { root } = await workspace.materialize();
				const ref = exportRefFor(handle, opts.kind, root);
				const exec = requireExec(ctx);
				const output = await exec.run(exportCommand(root, opts.kind, ref.path));
				if (!output.includes(`__PAREL_WORKSPACE_EXPORT__:${ref.path}`)) {
					throw new Error(`Workspace export failed:\n${output}`);
				}
				return { ref };
			},
			async metadata() {
				const handle = await current();
				return handle?.metadata ?? {};
			},
		};

		ctx.provide(WORKSPACE_CAPABILITY, workspace);

		ctx.tool(
			{
				name: "workspace_current",
				description: "Show the current session workspace handle and materialized root metadata.",
				parameters: { type: "object", properties: {} },
				scheduling: { defaultMode: "parallel" },
			},
			async () => {
				const handle = await current();
				if (!handle) return "No workspace is configured for this session.";
				return JSON.stringify(handle, null, 2);
			},
			{ scheduling: { defaultMode: "parallel" }, isConcurrencySafe: () => true },
		);

		ctx.tool(
			{
				name: "workspace_materialize",
				description: "Materialize the current session workspace into the sandbox filesystem.",
				parameters: {
					type: "object",
					properties: {
						force: {
							type: "boolean",
							description: "Force refresh even when the workspace already has a root.",
						},
					},
				},
				scheduling: { defaultMode: "exclusive" },
			},
			async (params: { force?: unknown }): Promise<ToolOutput> => {
				const result = await workspace.materialize({ force: params.force === true });
				return {
					content: `Workspace materialized at ${result.root}.`,
					refs: [{ type: "sandbox_path", path: result.root, metadata: { kind: "workspace_root" } }],
				};
			},
		);

		ctx.tool(
			{
				name: "workspace_export",
				description: "Export the current session workspace as a sandbox file reference.",
				parameters: {
					type: "object",
					properties: {
						kind: {
							type: "string",
							enum: ["diff", "patch", "archive"],
							description: "Export format. diff is the default.",
						},
					},
				},
				scheduling: { defaultMode: "exclusive" },
			},
			async (params: { kind?: unknown }): Promise<ToolOutput> => {
				const kind = params.kind === "patch" || params.kind === "archive" ? params.kind : "diff";
				const { ref } = await workspace.export({ kind });
				return {
					content: `Workspace export created at ${ref.path}.`,
					refs: [ref],
				};
			},
		);
	},
});
