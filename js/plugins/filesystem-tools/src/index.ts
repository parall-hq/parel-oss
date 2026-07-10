import { definePlugin, type ToolOutput } from "@parel/plugin-sdk";
import { WORKSPACE_CAPABILITY, type WorkspaceCapability } from "@parel/workspace";

export interface FilesystemCapability {
	readFile(
		path: string,
		opts?: { encoding?: "utf8" | "base64"; maxChars?: number },
	): Promise<string>;
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
// Image reads are returned as inline media on the tool result (multimodal-media
// tool-result leg): raw-size cap mirrors the platform's per-item media budget.
const MAX_IMAGE_READ_BYTES = 1_048_576; // 1 MiB raw
const IMAGE_MEDIA_TYPES: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
};

// Magic-byte signatures for self-checking the provider's base64 output: a
// sandbox whose filesystem view ignores `encoding` would hand back mangled
// UTF-8 — better a clear tool error than silently feeding garbage to the model.
const IMAGE_MAGIC: Record<string, number[]> = {
	"image/png": [0x89, 0x50, 0x4e, 0x47],
	"image/jpeg": [0xff, 0xd8, 0xff],
	"image/gif": [0x47, 0x49, 0x46, 0x38],
	"image/webp": [0x52, 0x49, 0x46, 0x46],
};

function base64RawBytes(data: string): number {
	const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
	return Math.floor((data.length * 3) / 4) - padding;
}

// Minimal base64 head decoder (platform-neutral: no atob/Buffer dependency).
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function decodeBase64Head(data: string, byteCount: number): number[] | null {
	const out: number[] = [];
	for (let i = 0; i + 3 < data.length && out.length < byteCount; i += 4) {
		const n = [0, 1, 2, 3].map((k) => B64.indexOf(data[i + k] ?? "="));
		if (n[0] < 0 || n[1] < 0) return null;
		out.push((n[0] << 2) | (n[1] >> 4));
		if (n[2] >= 0) out.push(((n[1] & 15) << 4) | (n[2] >> 2));
		if (n[2] >= 0 && n[3] >= 0) out.push(((n[2] & 3) << 6) | n[3]);
	}
	return out.slice(0, byteCount);
}

function matchesImageMagic(data: string, mediaType: string): boolean {
	const sig = IMAGE_MAGIC[mediaType];
	if (!sig) return false;
	const head = decodeBase64Head(data, sig.length);
	if (!head || head.length < sig.length) return false;
	return sig.every((byte, i) => head[i] === byte);
}

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
				description:
					"Read a file using a workspace-relative path. Text files return their contents; image files (png/jpg/gif/webp) are attached so you can see them.",
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
				// Image files come back as inline media on the tool result so a
				// vision-capable model can SEE them (multimodal-media tool-result leg).
				const ext = relative.split(".").pop()?.toLowerCase() ?? "";
				const imageMediaType = IMAGE_MEDIA_TYPES[ext];
				if (imageMediaType) {
					const data = await filesystem.readFile(absolute, { encoding: "base64" });
					const rawBytes = base64RawBytes(data);
					if (rawBytes > MAX_IMAGE_READ_BYTES) {
						return {
							content: `Error: image is ${rawBytes} bytes; the inline media limit is ${MAX_IMAGE_READ_BYTES} bytes`,
							isError: true,
						};
					}
					if (!matchesImageMagic(data, imageMediaType)) {
						return {
							content:
								"Error: could not read the file as binary — the sandbox provider may not support base64 reads, or the file is not a valid image",
							isError: true,
						};
					}
					return {
						content: `[image: ${imageMediaType}, ${rawBytes} bytes — attached]`,
						media: [{ data, mediaType: imageMediaType }],
						refs: [{ type: "workspace_path", path: relative, mediaType: imageMediaType }],
					};
				}
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
