import { definePlugin, type ToolOutput } from "@parel/plugin-sdk";
import { WORKSPACE_CAPABILITY, type WorkspaceCapability } from "@parel/workspace";

export interface ExecCapability {
	run(command: string): Promise<string>;
}

interface ShellToolsConfig {
	maxOutputBytes?: number;
}

interface ShellCommandParams {
	command?: unknown;
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

function numericParam(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : undefined;
}

function requiredCommand(value: unknown): string {
	if (typeof value !== "string" || !value.trim()) {
		throw new Error("command must be a non-empty string");
	}
	return value;
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}

function workspaceCommand(root: string, command: string): string {
	return `cd ${shellQuote(root.replace(/\/+$/, ""))} && ${command}`;
}

function boundedToolOutput(content: string, maxBytes: number): ToolOutput {
	const originalByteLength = byteLength(content);
	if (originalByteLength <= maxBytes) return { content };
	return {
		content: boundedPreview(
			content,
			maxBytes,
			`\n\n[truncated: command output is ${originalByteLength} bytes; redirect to a file for full output]`,
		),
		truncated: true,
		originalByteLength,
	};
}

export default definePlugin({
	name: "@parel/shell-tools",
	version: "0.1.0",
	provides: { tools: true },
	requires: { capabilities: [WORKSPACE_CAPABILITY, "exec"] },

	async setup(ctx) {
		const config = (ctx.config ?? {}) as ShellToolsConfig;
		const workspace = ctx.require<WorkspaceCapability>(WORKSPACE_CAPABILITY);
		const exec = ctx.require<ExecCapability>("exec");

		ctx.tool(
			{
				name: "workspace_shell",
				description: "Run a shell command from the current workspace root.",
				parameters: {
					type: "object",
					properties: {
						command: { type: "string", description: "Shell command to run." },
						maxBytes: { type: "number", description: "Optional max bytes returned to the model." },
					},
					required: ["command"],
				},
				scheduling: { defaultMode: "exclusive" },
			},
			async (params: ShellCommandParams): Promise<ToolOutput> => {
				const command = requiredCommand(params.command);
				const root = await workspace.root();
				const output = await exec.run(workspaceCommand(root, command));
				const content = output.length > 0 ? output : "Command completed with no output.";
				const maxBytes =
					numericParam(params.maxBytes) ?? config.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
				return boundedToolOutput(content, maxBytes);
			},
		);
	},
});
