import { definePlugin, type ToolOutput } from "@parel/plugin-sdk";
import { WORKSPACE_CAPABILITY, type WorkspaceCapability } from "@parel/workspace";

export interface ExecCapability {
	run(command: string): Promise<string>;
}

interface SearchToolsConfig {
	maxMatches?: number;
	maxOutputBytes?: number;
}

interface SearchTextParams {
	query?: unknown;
	path?: unknown;
	maxMatches?: unknown;
	maxBytes?: unknown;
}

interface FindFilesParams {
	pattern?: unknown;
	path?: unknown;
	maxMatches?: unknown;
	maxBytes?: unknown;
}

const DEFAULT_MAX_MATCHES = 100;
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
			`\n\n[truncated: search output is ${originalByteLength} bytes; narrow the query or path]`,
		),
		truncated: true,
		originalByteLength,
	};
}

function numericParam(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : undefined;
}

function boundedPositiveInt(value: number | undefined, fallback: number, max: number): number {
	const candidate = value ?? fallback;
	if (candidate < 1) return 1;
	if (candidate > max) return max;
	return Math.floor(candidate);
}

function requiredQuery(value: unknown): string {
	if (typeof value !== "string" || !value.trim()) {
		throw new Error("query must be a non-empty string");
	}
	if (value.includes("\0")) throw new Error("query must not contain NUL bytes");
	return value;
}

function requiredPattern(value: unknown): string {
	if (typeof value !== "string" || !value.trim()) {
		throw new Error("pattern must be a non-empty string");
	}
	if (value.includes("\0")) throw new Error("pattern must not contain NUL bytes");
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

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}

function workspaceCommand(root: string, command: string): string {
	return `cd ${shellQuote(root.replace(/\/+$/, ""))} && ${command}`;
}

function searchCommand(query: string, path: string, maxMatches: number): string {
	return [
		"grep",
		"-RInI",
		"--exclude-dir=.git",
		"--",
		shellQuote(query),
		shellQuote(path),
		"|",
		"head",
		"-n",
		String(maxMatches),
		"||",
		"true",
	].join(" ");
}

function findFilesCommand(pattern: string, path: string, maxMatches: number): string {
	return [
		"find",
		shellQuote(path),
		"-path",
		shellQuote("*/.git"),
		"-prune",
		"-o",
		"-type",
		"f",
		"-name",
		shellQuote(pattern),
		"-print",
		"|",
		"head",
		"-n",
		String(maxMatches),
		"||",
		"true",
	].join(" ");
}

export default definePlugin({
	name: "@parel/search-tools",
	version: "0.1.0",
	provides: { tools: true },
	requires: { capabilities: [WORKSPACE_CAPABILITY, "exec"] },

	async setup(ctx) {
		const config = (ctx.config ?? {}) as SearchToolsConfig;
		const workspace = ctx.require<WorkspaceCapability>(WORKSPACE_CAPABILITY);
		const exec = ctx.require<ExecCapability>("exec");

		ctx.tool(
			{
				name: "workspace_search_text",
				description: "Search text in workspace files using a workspace-relative path.",
				parameters: {
					type: "object",
					properties: {
						query: { type: "string", description: "Literal text or grep pattern to search for." },
						path: { type: "string", description: "Optional workspace-relative path to search." },
						maxMatches: { type: "number", description: "Optional max number of matching lines." },
						maxBytes: { type: "number", description: "Optional max bytes returned to the model." },
					},
					required: ["query"],
				},
				scheduling: { defaultMode: "parallel" },
			},
			async (params: SearchTextParams): Promise<ToolOutput> => {
				const query = requiredQuery(params.query);
				const path = relativePath(params.path, ".");
				const maxMatches = boundedPositiveInt(
					numericParam(params.maxMatches),
					config.maxMatches ?? DEFAULT_MAX_MATCHES,
					1000,
				);
				const maxBytes =
					numericParam(params.maxBytes) ?? config.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
				const root = await workspace.root();
				const output = await exec.run(
					workspaceCommand(root, searchCommand(query, path, maxMatches)),
				);
				const content = output.length > 0 ? output : "No matches.";
				return {
					...boundedToolOutput(content, maxBytes),
					refs: [{ type: "workspace_path", path, metadata: { query } }],
				};
			},
			{ scheduling: { defaultMode: "parallel" }, isConcurrencySafe: () => true },
		);

		ctx.tool(
			{
				name: "workspace_find_files",
				description:
					"Find workspace files by shell-style name pattern using a workspace-relative path.",
				parameters: {
					type: "object",
					properties: {
						pattern: {
							type: "string",
							description: "Shell-style filename pattern, for example *.ts or package.json.",
						},
						path: {
							type: "string",
							description: "Optional workspace-relative directory to search.",
						},
						maxMatches: { type: "number", description: "Optional max number of file paths." },
						maxBytes: { type: "number", description: "Optional max bytes returned to the model." },
					},
					required: ["pattern"],
				},
				scheduling: { defaultMode: "parallel" },
			},
			async (params: FindFilesParams): Promise<ToolOutput> => {
				const pattern = requiredPattern(params.pattern);
				const path = relativePath(params.path, ".");
				const maxMatches = boundedPositiveInt(
					numericParam(params.maxMatches),
					config.maxMatches ?? DEFAULT_MAX_MATCHES,
					5000,
				);
				const maxBytes =
					numericParam(params.maxBytes) ?? config.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
				const root = await workspace.root();
				const output = await exec.run(
					workspaceCommand(root, findFilesCommand(pattern, path, maxMatches)),
				);
				const content = output.length > 0 ? output : "No files found.";
				return {
					...boundedToolOutput(content, maxBytes),
					refs: [{ type: "workspace_path", path, metadata: { pattern } }],
				};
			},
			{ scheduling: { defaultMode: "parallel" }, isConcurrencySafe: () => true },
		);
	},
});
