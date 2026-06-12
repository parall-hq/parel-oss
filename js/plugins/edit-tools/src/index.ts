import { definePlugin, type ToolOutput } from "@parel/plugin-sdk";
import { WORKSPACE_CAPABILITY, type WorkspaceCapability } from "@parel/workspace";

export interface FilesystemCapability {
	readFile(path: string): Promise<string>;
	writeFile(path: string, content: string): Promise<void>;
}

export interface ExecCapability {
	run(command: string): Promise<string>;
}

interface EditFileParams {
	path?: unknown;
	oldText?: unknown;
	newText?: unknown;
	expectedReplacements?: unknown;
}

interface ApplyPatchParams {
	patch?: unknown;
	checkOnly?: unknown;
	maxBytes?: unknown;
}

interface EditToolsConfig {
	maxPatchBytes?: number;
	maxOutputBytes?: number;
}

const DEFAULT_MAX_PATCH_BYTES = 256 * 1024;
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

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}

function requiredText(value: unknown, name: string): string {
	if (typeof value !== "string") throw new Error(`${name} must be a string`);
	if (name === "oldText" && value.length === 0) throw new Error("oldText must not be empty");
	return value;
}

function expectedCount(value: unknown): number {
	if (value === undefined) return 1;
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new Error("expectedReplacements must be a positive integer");
	}
	const count = Math.floor(value);
	if (count < 1) throw new Error("expectedReplacements must be a positive integer");
	return count;
}

function countOccurrences(content: string, needle: string): number {
	let count = 0;
	let index = 0;
	for (;;) {
		const found = content.indexOf(needle, index);
		if (found === -1) return count;
		count += 1;
		index = found + needle.length;
	}
}

function numericParam(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : undefined;
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
			`\n\n[truncated: patch output is ${originalByteLength} bytes; inspect git diff for details]`,
		),
		truncated: true,
		originalByteLength,
	};
}

function requiredPatch(value: unknown, maxBytes: number): string {
	if (typeof value !== "string" || value.length === 0) {
		throw new Error("patch must be a non-empty string");
	}
	if (value.includes("\0")) throw new Error("patch must not contain NUL bytes");
	const bytes = byteLength(value);
	if (bytes > maxBytes) throw new Error(`patch is ${bytes} bytes; max is ${maxBytes}`);
	return value;
}

function workspaceCommand(root: string, command: string): string {
	return `cd ${shellQuote(root.replace(/\/+$/, ""))} && ${command}`;
}

function applyPatchCommand(patch: string, checkOnly: boolean): string {
	const script = [
		"tmp=$(mktemp /tmp/parel-apply-patch.XXXXXX)",
		'cleanup() { rm -f "$tmp"; }',
		"trap cleanup EXIT",
		`printf %s ${shellQuote(patch)} > "$tmp"`,
		'git apply --check "$tmp"',
		checkOnly ? "printf 'Patch check passed.\\n'" : 'git apply "$tmp" && git diff --stat --',
	].join("\n");
	return `sh -lc ${shellQuote(script)}`;
}

export default definePlugin({
	name: "@parel/edit-tools",
	version: "0.1.0",
	provides: { tools: true },
	requires: { capabilities: [WORKSPACE_CAPABILITY, "filesystem", "exec"] },

	async setup(ctx) {
		const config = (ctx.config ?? {}) as EditToolsConfig;
		const workspace = ctx.require<WorkspaceCapability>(WORKSPACE_CAPABILITY);
		const filesystem = ctx.require<FilesystemCapability>("filesystem");
		const exec = ctx.require<ExecCapability>("exec");

		async function resolvePath(input: unknown) {
			const root = await workspace.root();
			const relative = relativePath(input);
			return { relative, absolute: workspacePath(root, relative) };
		}

		ctx.tool(
			{
				name: "workspace_edit_file",
				description: "Apply an exact text replacement to a workspace-relative file.",
				parameters: {
					type: "object",
					properties: {
						path: { type: "string", description: "Workspace-relative file path." },
						oldText: { type: "string", description: "Exact text to replace." },
						newText: { type: "string", description: "Replacement text." },
						expectedReplacements: {
							type: "number",
							description: "Expected number of replacements; defaults to 1.",
						},
					},
					required: ["path", "oldText", "newText"],
				},
				scheduling: { defaultMode: "exclusive" },
			},
			async (params: EditFileParams): Promise<ToolOutput> => {
				const { relative, absolute } = await resolvePath(params.path);
				const oldText = requiredText(params.oldText, "oldText");
				const newText = requiredText(params.newText, "newText");
				const expected = expectedCount(params.expectedReplacements);
				const content = await filesystem.readFile(absolute);
				const found = countOccurrences(content, oldText);
				if (found !== expected) {
					throw new Error(`expected ${expected} replacement(s), found ${found} in ${relative}`);
				}
				const next = content.split(oldText).join(newText);
				await filesystem.writeFile(absolute, next);
				return {
					content: `Replaced ${found} occurrence(s) in ${relative}; new size is ${byteLength(next)} bytes.`,
					refs: [{ type: "workspace_path", path: relative, mediaType: "text/plain" }],
					fullContentRef: { type: "workspace_path", path: relative, mediaType: "text/plain" },
				};
			},
		);

		ctx.tool(
			{
				name: "workspace_apply_patch",
				description: "Apply a unified diff patch from the current workspace root using git apply.",
				parameters: {
					type: "object",
					properties: {
						patch: { type: "string", description: "Unified diff patch to apply." },
						checkOnly: {
							type: "boolean",
							description: "Only validate that the patch applies; do not modify files.",
						},
						maxBytes: { type: "number", description: "Optional max bytes returned to the model." },
					},
					required: ["patch"],
				},
				scheduling: { defaultMode: "exclusive" },
			},
			async (params: ApplyPatchParams): Promise<ToolOutput> => {
				const patch = requiredPatch(params.patch, config.maxPatchBytes ?? DEFAULT_MAX_PATCH_BYTES);
				const root = await workspace.root();
				const output = await exec.run(
					workspaceCommand(root, applyPatchCommand(patch, params.checkOnly === true)),
				);
				const content =
					output.length > 0
						? output
						: params.checkOnly === true
							? "Patch check passed."
							: "Patch applied.";
				const maxBytes =
					numericParam(params.maxBytes) ?? config.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
				return boundedToolOutput(content, maxBytes);
			},
		);
	},
});
