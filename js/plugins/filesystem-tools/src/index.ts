import { definePlugin, type ToolOutput } from "@parel/plugin-sdk";
import { WORKSPACE_CAPABILITY, type WorkspaceCapability } from "@parel/workspace";

export interface FilesystemCapability {
	readFile(path: string): Promise<string>;
	writeFile(path: string, content: string): Promise<void>;
	exists?(path: string): Promise<boolean>;
	listDir(path: string): Promise<string[]>;
}

interface FilesystemToolsConfig {
	maxReadBytes?: number;
}

interface ReadFileParams {
	path?: unknown;
	startLine?: unknown;
	endLine?: unknown;
	maxBytes?: unknown;
}

interface WriteFileParams {
	path?: unknown;
	content?: unknown;
}

interface ListDirParams {
	path?: unknown;
}

const DEFAULT_MAX_READ_BYTES = 64 * 1024;

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

function workspacePath(root: string, relative: string): string {
	const normalizedRoot = root.replace(/\/+$/, "");
	return relative === "." ? normalizedRoot : `${normalizedRoot}/${relative}`;
}

function numericParam(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : undefined;
}

function sliceLines(content: string, startLine?: number, endLine?: number): string {
	if (!startLine && !endLine) return content;
	const lines = content.split(/\r?\n/);
	const start = Math.max(1, startLine ?? 1);
	const end = Math.min(lines.length, endLine ?? lines.length);
	if (end < start) return "";
	return lines.slice(start - 1, end).join("\n");
}

export default definePlugin({
	name: "@parel/filesystem-tools",
	version: "0.1.0",
	provides: { tools: true },
	requires: { capabilities: [WORKSPACE_CAPABILITY, "filesystem"] },

	async setup(ctx) {
		const config = (ctx.config ?? {}) as FilesystemToolsConfig;
		const workspace = ctx.require<WorkspaceCapability>(WORKSPACE_CAPABILITY);
		const filesystem = ctx.require<FilesystemCapability>("filesystem");

		async function resolvePath(input: unknown, fallback = ".") {
			const root = await workspace.root();
			const relative = relativePath(input, fallback);
			return { root, relative, absolute: workspacePath(root, relative) };
		}

		ctx.tool(
			{
				name: "workspace_read_file",
				description: "Read a UTF-8 text file using a workspace-relative path.",
				parameters: {
					type: "object",
					properties: {
						path: { type: "string", description: "Workspace-relative file path." },
						startLine: { type: "number", description: "Optional 1-based start line." },
						endLine: { type: "number", description: "Optional inclusive end line." },
						maxBytes: { type: "number", description: "Optional max bytes returned to the model." },
					},
					required: ["path"],
				},
				scheduling: { defaultMode: "parallel" },
			},
			async (params: ReadFileParams): Promise<ToolOutput> => {
				const { relative, absolute } = await resolvePath(params.path);
				const raw = await filesystem.readFile(absolute);
				const sliced = sliceLines(
					raw,
					numericParam(params.startLine),
					numericParam(params.endLine),
				);
				const maxBytes =
					numericParam(params.maxBytes) ?? config.maxReadBytes ?? DEFAULT_MAX_READ_BYTES;
				const originalByteLength = byteLength(sliced);
				if (originalByteLength <= maxBytes) {
					return {
						content: sliced,
						refs: [{ type: "workspace_path", path: relative, mediaType: "text/plain" }],
						fullContentRef: { type: "workspace_path", path: relative, mediaType: "text/plain" },
					};
				}
				return {
					content: boundedPreview(
						sliced,
						maxBytes,
						`\n\n[truncated: file content is ${originalByteLength} bytes; use a smaller range]`,
					),
					refs: [{ type: "workspace_path", path: relative, mediaType: "text/plain" }],
					fullContentRef: { type: "workspace_path", path: relative, mediaType: "text/plain" },
					truncated: true,
					originalByteLength,
				};
			},
			{ scheduling: { defaultMode: "parallel" }, isConcurrencySafe: () => true },
		);

		ctx.tool(
			{
				name: "workspace_list_dir",
				description: "List entries in a workspace-relative directory.",
				parameters: {
					type: "object",
					properties: {
						path: { type: "string", description: "Workspace-relative directory path." },
					},
				},
				scheduling: { defaultMode: "parallel" },
			},
			async (params: ListDirParams): Promise<string> => {
				const { relative, absolute } = await resolvePath(params.path, ".");
				const entries = await filesystem.listDir(absolute);
				return JSON.stringify({ path: relative, entries }, null, 2);
			},
			{ scheduling: { defaultMode: "parallel" }, isConcurrencySafe: () => true },
		);

		ctx.tool(
			{
				name: "workspace_write_file",
				description: "Write a UTF-8 text file using a workspace-relative path.",
				parameters: {
					type: "object",
					properties: {
						path: { type: "string", description: "Workspace-relative file path." },
						content: { type: "string", description: "File content to write." },
					},
					required: ["path", "content"],
				},
				scheduling: { defaultMode: "exclusive" },
			},
			async (params: WriteFileParams): Promise<string> => {
				if (typeof params.content !== "string") return "Error: content must be a string.";
				const { relative, absolute } = await resolvePath(params.path);
				await filesystem.writeFile(absolute, params.content);
				return `Wrote ${byteLength(params.content)} bytes to ${relative}.`;
			},
		);
	},
});
