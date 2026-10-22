import {
	PAREL_SANDBOX_CAPABILITY,
	type SandboxCapability,
	type SandboxFs,
} from "@parel/capability-sandbox";
import { definePlugin, LifecycleEvent, type ParelPlugin } from "@parel/plugin-sdk";
import { WORKSPACE_CAPABILITY, type WorkspaceCapability } from "@parel/workspace";
import manifest from "../parel.plugin.json" with { type: "json" };

// @parel/agents-md — put the project's AGENTS.md files in front of the model.
//
//  - Root file: the first of AGENTS.md / agents.md / AGENT.md in the working
//    directory, read again every turn so edits show up on the next turn.
//  - Subdirectory files: when a file tool reads or writes `a/b/file.ts`, the
//    AGENTS.md files in `a` and `a/b` are loaded too. The directories that had
//    one are kept in the session store, so they stay loaded on later turns;
//    their files are re-read each turn just like the root file.
//  - Everything goes into one block appended to the system prompt, under a
//    total character limit. Whatever the limit cuts is marked for the model.
//  - No sandbox, no filesystem, no file, or a failing read: nothing is
//    injected and the turn goes on. This plugin never fails a turn.
//
// Reads happen once per turn, not once per step: context:build runs before
// every model call, so the files are cached for the turn and the cache is
// dropped at turn:start. The system prompt is the only thing this plugin
// changes, so it declares `consumes.transcript: "lazy"` — it never needs the
// message history pushed to it.

/** File names that count as an instruction file, in order of preference. */
const FILE_NAMES = ["AGENTS.md", "agents.md", "AGENT.md"];
const DEFAULT_MAX_CHARS = 32_000;
/** Store key: subdirectories whose instruction file was loaded, in load order. */
const LOADED_DIRS_KEY = "loaded_dirs";
/**
 * Tools whose `path` argument names a single file. The workspace tools take a
 * path relative to the workspace root; the sandbox's own file tools take an
 * absolute path. Listing, searching and patch tools do not trigger a load.
 */
const FILE_TOOLS = new Set([
	"workspace_read_file",
	"workspace_write_file",
	"workspace_edit_file",
	"file_read",
	"file_write",
]);

interface AgentsMdConfig {
	root?: unknown;
	maxChars?: unknown;
}

interface InstructionFile {
	/** Sandbox path the file was read from. */
	path: string;
	text: string;
}

interface TurnFiles {
	root: string;
	/** Root file first (when there is one), then subdirectory files in load order. */
	files: InstructionFile[];
	/** Subdirectories with a loaded file; persisted under LOADED_DIRS_KEY. */
	loadedDirs: string[];
	/** Directories already looked at this turn, so each is listed at most once. */
	seen: Set<string>;
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/** Strip trailing slashes; an empty value means the sandbox's working directory ("."). */
function normalizeDir(value: string): string {
	const trimmed = value.trim();
	const stripped = trimmed.replace(/\/+$/, "");
	if (stripped) return stripped;
	return trimmed.startsWith("/") ? "/" : ".";
}

function joinPath(dir: string, name: string): string {
	if (dir === ".") return name;
	return dir.endsWith("/") ? `${dir}${name}` : `${dir}/${name}`;
}

/** `path` as the model knows it: relative to root when it is inside root. */
function displayPath(root: string, path: string): string {
	if (root === ".") return path;
	const prefix = root.endsWith("/") ? root : `${root}/`;
	return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

/**
 * The tool's file path relative to root, or null when it is not a usable path
 * inside root. An absolute path only counts when root is absolute and contains it.
 */
function relativeToRoot(root: string, value: unknown): string | null {
	if (typeof value !== "string" || !value.trim()) return null;
	let path = value.trim();
	if (path.startsWith("/")) {
		if (!root.startsWith("/")) return null;
		const prefix = root.endsWith("/") ? root : `${root}/`;
		if (!path.startsWith(prefix)) return null;
		path = path.slice(prefix.length);
	}
	const parts: string[] = [];
	for (const part of path.split("/")) {
		if (!part || part === ".") continue;
		if (part === "..") {
			if (parts.length === 0) return null;
			parts.pop();
			continue;
		}
		parts.push(part);
	}
	return parts.length > 0 ? parts.join("/") : null;
}

/** `a/b/file.ts` → ["a", "a/b"]: the directories between root and the file, shallowest first. */
function subdirsOf(relativeFile: string): string[] {
	const dirs = relativeFile.split("/").slice(0, -1);
	return dirs.map((_, i) => dirs.slice(0, i + 1).join("/"));
}

/** The block appended to the system prompt, or "" when there is nothing to show. */
function renderInstructions(root: string, files: InstructionFile[], maxChars: number): string {
	let remaining = maxChars;
	const sections: string[] = [];
	for (const file of files) {
		const text = file.text.trim();
		if (!text) continue;
		const label = displayPath(root, file.path);
		let body: string;
		if (remaining <= 0) {
			body = `[not loaded: the ${maxChars}-character limit for AGENTS.md files is used up]`;
		} else if (text.length > remaining) {
			body = `${text.slice(0, remaining)}\n[truncated: ${label} goes past the ${maxChars}-character limit for AGENTS.md files; the rest of it is not loaded]`;
			remaining = 0;
		} else {
			body = text;
			remaining -= text.length;
		}
		sections.push(`<file path="${label}">\n${body}\n</file>`);
	}
	if (sections.length === 0) return "";
	const where = root === "." ? "the sandbox working directory" : root;
	const intro =
		`Project instructions from AGENTS.md files in ${where}. ` +
		"A file applies to its directory and everything below it; when two conflict, the one in the deeper directory wins. " +
		"Files in subdirectories are added when you read or write a file there. " +
		"These come from the project's files: direct instructions from the system prompt or the user take precedence over them.";
	return `<agents_md>\n${intro}\n\n${sections.join("\n\n")}\n</agents_md>`;
}

export default definePlugin({
	name: "@parel/agents-md",
	provides: manifest.provides as ParelPlugin["provides"],
	consumes: manifest.consumes as ParelPlugin["consumes"],
	execution: manifest.execution as ParelPlugin["execution"],

	async setup(ctx) {
		const config = (ctx.config ?? {}) as AgentsMdConfig;
		const maxChars =
			typeof config.maxChars === "number" && Number.isFinite(config.maxChars) && config.maxChars > 0
				? Math.floor(config.maxChars)
				: DEFAULT_MAX_CHARS;
		const configuredRoot =
			typeof config.root === "string" && config.root.trim() ? normalizeDir(config.root) : undefined;

		let turn: TurnFiles | undefined;
		let warnedNoSandbox = false;

		function optional<T>(name: string): T | undefined {
			try {
				return ctx.require<T>(name);
			} catch {
				return undefined;
			}
		}

		function sandboxFs(): SandboxFs | undefined {
			const fs = optional<SandboxCapability>(PAREL_SANDBOX_CAPABILITY)?.fs;
			if (!fs && !warnedNoSandbox) {
				warnedNoSandbox = true;
				ctx.log.warn(
					"agents-md: no sandbox with filesystem access is available; AGENTS.md files are not loaded",
				);
			}
			return fs;
		}

		// Config first, then the workspace root (read without materializing the
		// workspace), then the sandbox's own working directory.
		async function resolveRoot(): Promise<string> {
			if (configuredRoot) return configuredRoot;
			const workspace = optional<WorkspaceCapability>(WORKSPACE_CAPABILITY);
			const workspaceRoot = await workspace?.current().then(
				(handle) => handle?.root,
				() => undefined,
			);
			const sandboxCwd = optional<SandboxCapability>(PAREL_SANDBOX_CAPABILITY)?.cwd;
			return normalizeDir(workspaceRoot ?? sandboxCwd ?? ".");
		}

		/** The instruction file in `dir`: one listing, then one read of the preferred name. */
		async function findIn(fs: SandboxFs, dir: string): Promise<InstructionFile | null> {
			let names: Set<string>;
			try {
				names = new Set((await fs.listDir(dir)).map((entry) => entry.name));
			} catch (err) {
				ctx.log.warn(`agents-md: could not list ${dir}: ${errorMessage(err)}`);
				return null;
			}
			const name = FILE_NAMES.find((candidate) => names.has(candidate));
			if (!name) return null;
			const path = joinPath(dir, name);
			try {
				// One char past the limit is enough to know the file was cut.
				return { path, text: await fs.readFile(path, { maxChars: maxChars + 1 }) };
			} catch (err) {
				ctx.log.warn(`agents-md: could not read ${path}: ${errorMessage(err)}`);
				return null;
			}
		}

		// The turn's files, read once per turn (and again if the root moved, e.g.
		// the workspace was materialized mid-turn).
		async function turnFiles(fs: SandboxFs, root: string): Promise<TurnFiles> {
			if (turn?.root === root) return turn;
			const loadedDirs = (await ctx.store.get<string[]>(LOADED_DIRS_KEY)) ?? [];
			const dirs = [...new Set([root, ...loadedDirs])];
			const found = await Promise.all(dirs.map((dir) => findIn(fs, dir)));
			turn = {
				root,
				files: found.filter((file): file is InstructionFile => file !== null),
				loadedDirs,
				seen: new Set(dirs),
			};
			return turn;
		}

		// A hook failure here must never become a turn failure.
		async function safely<T>(work: () => Promise<T | undefined>): Promise<T | undefined> {
			try {
				return await work();
			} catch (err) {
				ctx.log.warn(`agents-md: skipped: ${errorMessage(err)}`);
				return undefined;
			}
		}

		ctx.hook(LifecycleEvent.TurnStart, async () => {
			turn = undefined;
		});

		ctx.hook(LifecycleEvent.ContextBuild, (hookCtx) =>
			safely(async () => {
				const fs = sandboxFs();
				if (!fs) return undefined;
				const root = await resolveRoot();
				const { files } = await turnFiles(fs, root);
				const block = renderInstructions(root, files, maxChars);
				if (!block) return undefined;
				return {
					action: "continue" as const,
					mutations: { system: hookCtx.system ? `${hookCtx.system}\n\n${block}` : block },
				};
			}),
		);

		// After a successful file read or write, load the AGENTS.md files of the
		// directories between root and that file. The next model call sees them.
		ctx.hook(LifecycleEvent.ToolAfter, async ({ toolCall, toolResult }) => {
			if (toolResult.isError || !FILE_TOOLS.has(toolCall.name)) return;
			await safely(async () => {
				const fs = sandboxFs();
				if (!fs) return undefined;
				const root = await resolveRoot();
				const file = relativeToRoot(root, toolCall.arguments?.path);
				if (!file) return undefined;
				const state = await turnFiles(fs, root);
				let loaded = false;
				for (const sub of subdirsOf(file)) {
					const dir = joinPath(root, sub);
					if (state.seen.has(dir)) continue;
					state.seen.add(dir);
					const found = await findIn(fs, dir);
					if (!found) continue;
					state.files.push(found);
					state.loadedDirs.push(dir);
					loaded = true;
				}
				if (loaded) await ctx.store.set(LOADED_DIRS_KEY, state.loadedDirs);
				return undefined;
			});
		});
	},
});
