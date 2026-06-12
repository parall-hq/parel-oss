import { definePlugin, type ToolOutput } from "@parel/plugin-sdk";
import { WORKSPACE_CAPABILITY, type WorkspaceCapability } from "@parel/workspace";

export interface ExecCapability {
	run(command: string): Promise<string>;
}

interface GitToolsConfig {
	maxOutputBytes?: number;
}

interface GitDiffParams {
	path?: unknown;
	staged?: unknown;
	maxBytes?: unknown;
}

interface GitCommitParams {
	message?: unknown;
	paths?: unknown;
	allowEmpty?: unknown;
	maxBytes?: unknown;
}

interface GitSwitchBranchParams {
	branch?: unknown;
	create?: unknown;
	maxBytes?: unknown;
}

const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;

function byteLength(text: string): number {
	let bytes = 0;
	for (const char of text) {
		const codePoint = char.codePointAt(0) ?? 0;
		if (codePoint <= 0x7f) bytes += 1;
		else if (codePoint <= 0x7ff) bytes += 2;
		else if (codePoint <= 0xffff) bytes += 3;
		else bytes += 4;
	}
	return bytes;
}

function truncateUtf8(text: string, maxBytes: number): string {
	if (maxBytes <= 0) return "";
	let used = 0;
	let result = "";
	for (const char of text) {
		const charBytes = byteLength(char);
		if (used + charBytes > maxBytes) break;
		result += char;
		used += charBytes;
	}
	return result;
}

function boundedPreview(content: string, maxBytes: number, suffix: string): string {
	const suffixBytes = byteLength(suffix);
	if (suffixBytes >= maxBytes) return truncateUtf8(suffix, maxBytes);
	return `${truncateUtf8(content, maxBytes - suffixBytes)}${suffix}`;
}

function boundedToolOutput(content: string, maxBytes: number): ToolOutput {
	const originalByteLength = byteLength(content);
	if (originalByteLength <= maxBytes) return { content };
	return {
		content: boundedPreview(
			content,
			maxBytes,
			`\n\n[truncated: git output is ${originalByteLength} bytes; narrow the path]`,
		),
		truncated: true,
		originalByteLength,
	};
}

function numericParam(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : undefined;
}

function requiredString(value: unknown, name: string): string {
	if (typeof value !== "string" || !value.trim()) {
		throw new Error(`${name} must be a non-empty string`);
	}
	if (value.includes("\0")) throw new Error(`${name} must not contain NUL bytes`);
	return value.trim();
}

function relativePath(input: unknown, fallback = "."): string {
	const raw = typeof input === "string" && input.trim() ? input.trim() : fallback;
	if (raw.startsWith("/")) throw new Error("path must be workspace-relative");
	const parts: string[] = [];
	for (const part of raw.split("/")) {
		if (!part || part === ".") continue;
		if (part === "..") {
			if (parts.length === 0) throw new Error("path must stay inside the workspace");
			parts.pop();
			continue;
		}
		parts.push(part);
	}
	return parts.join("/") || ".";
}

function relativePaths(input: unknown): string[] {
	if (input === undefined) return [];
	const values = Array.isArray(input) ? input : [input];
	if (values.length === 0) return [];
	return values.map((value) => relativePath(value));
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}

function workspaceCommand(root: string, command: string): string {
	return `cd ${shellQuote(root.replace(/\/+$/, ""))} && ${command}`;
}

function gitDiffCommand(path: string, staged: boolean): string {
	const args = ["git", "diff"];
	if (staged) args.push("--staged");
	args.push("--", shellQuote(path));
	return args.join(" ");
}

function gitAddCommand(paths: string[]): string {
	if (paths.length === 0) return ":";
	return ["git", "add", "--", ...paths.map(shellQuote)].join(" ");
}

function gitCommitCommand(message: string, paths: string[], allowEmpty: boolean): string {
	const commit = ["git", "commit", "-m", shellQuote(message)];
	if (allowEmpty) commit.push("--allow-empty");
	return `${gitAddCommand(paths)} && ${commit.join(" ")} && git status --short --branch`;
}

function gitSwitchBranchCommand(branch: string, create: boolean): string {
	return create
		? `git switch -c ${shellQuote(branch)} && git status --short --branch`
		: `git switch ${shellQuote(branch)} && git status --short --branch`;
}

export default definePlugin({
	name: "@parel/git-tools",
	version: "0.1.0",
	provides: { tools: true },
	requires: { capabilities: [WORKSPACE_CAPABILITY, "exec"] },

	async setup(ctx) {
		const config = (ctx.config ?? {}) as GitToolsConfig;
		const workspace = ctx.require<WorkspaceCapability>(WORKSPACE_CAPABILITY);
		const exec = ctx.require<ExecCapability>("exec");

		async function runWorkspaceCommand(command: string) {
			const root = await workspace.root();
			return exec.run(workspaceCommand(root, command));
		}

		ctx.tool(
			{
				name: "workspace_git_status",
				description: "Show Git status for the current workspace.",
				parameters: { type: "object", properties: {} },
				scheduling: { defaultMode: "parallel" },
			},
			async (): Promise<ToolOutput> => {
				const output = await runWorkspaceCommand("git status --short --branch");
				return boundedToolOutput(
					output.length > 0 ? output : "No git status output.",
					DEFAULT_MAX_OUTPUT_BYTES,
				);
			},
			{ scheduling: { defaultMode: "parallel" }, isConcurrencySafe: () => true },
		);

		ctx.tool(
			{
				name: "workspace_git_diff",
				description: "Show Git diff for the current workspace or a workspace-relative path.",
				parameters: {
					type: "object",
					properties: {
						path: { type: "string", description: "Optional workspace-relative path." },
						staged: {
							type: "boolean",
							description: "Show staged diff instead of working tree diff.",
						},
						maxBytes: { type: "number", description: "Optional max bytes returned to the model." },
					},
				},
				scheduling: { defaultMode: "parallel" },
			},
			async (params: GitDiffParams): Promise<ToolOutput> => {
				const path = relativePath(params.path, ".");
				const maxBytes =
					numericParam(params.maxBytes) ?? config.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
				const output = await runWorkspaceCommand(gitDiffCommand(path, params.staged === true));
				return {
					...boundedToolOutput(output.length > 0 ? output : "No diff.", maxBytes),
					refs: [{ type: "workspace_path", path }],
				};
			},
			{ scheduling: { defaultMode: "parallel" }, isConcurrencySafe: () => true },
		);

		ctx.tool(
			{
				name: "workspace_git_branches",
				description: "List local and remote Git branches for the current workspace.",
				parameters: { type: "object", properties: {} },
				scheduling: { defaultMode: "parallel" },
			},
			async (): Promise<ToolOutput> => {
				const output = await runWorkspaceCommand(
					"printf 'current: '; git branch --show-current; git branch --all --no-color",
				);
				return boundedToolOutput(
					output.length > 0 ? output : "No git branch output.",
					DEFAULT_MAX_OUTPUT_BYTES,
				);
			},
			{ scheduling: { defaultMode: "parallel" }, isConcurrencySafe: () => true },
		);

		ctx.tool(
			{
				name: "workspace_git_switch_branch",
				description: "Switch to an existing branch, or create and switch to a new branch.",
				parameters: {
					type: "object",
					properties: {
						branch: { type: "string", description: "Branch name to switch to." },
						create: {
							type: "boolean",
							description: "Create the branch before switching.",
						},
						maxBytes: { type: "number", description: "Optional max bytes returned to the model." },
					},
					required: ["branch"],
				},
				scheduling: { defaultMode: "exclusive" },
			},
			async (params: GitSwitchBranchParams): Promise<ToolOutput> => {
				const branch = requiredString(params.branch, "branch");
				const maxBytes =
					numericParam(params.maxBytes) ?? config.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
				const output = await runWorkspaceCommand(
					gitSwitchBranchCommand(branch, params.create === true),
				);
				return boundedToolOutput(output.length > 0 ? output : `Switched to ${branch}.`, maxBytes);
			},
		);

		ctx.tool(
			{
				name: "workspace_git_commit",
				description:
					"Create a Git commit. By default commits already-staged changes only; pass workspace-relative paths to stage specific files first.",
				parameters: {
					type: "object",
					properties: {
						message: { type: "string", description: "Commit message." },
						paths: {
							type: "array",
							items: { type: "string" },
							description:
								"Optional workspace-relative paths to stage before committing. If omitted, only already-staged changes are committed.",
						},
						allowEmpty: {
							type: "boolean",
							description: "Allow an empty commit.",
						},
						maxBytes: { type: "number", description: "Optional max bytes returned to the model." },
					},
					required: ["message"],
				},
				scheduling: { defaultMode: "exclusive" },
			},
			async (params: GitCommitParams): Promise<ToolOutput> => {
				const message = requiredString(params.message, "message");
				const paths = relativePaths(params.paths);
				const maxBytes =
					numericParam(params.maxBytes) ?? config.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
				const output = await runWorkspaceCommand(
					gitCommitCommand(message, paths, params.allowEmpty === true),
				);
				return {
					...boundedToolOutput(output.length > 0 ? output : "Commit completed.", maxBytes),
					refs: paths.map((path) => ({ type: "workspace_path" as const, path })),
				};
			},
		);
	},
});
