import { definePlugin, type ToolContentRef, type ToolOutput } from "@parel/plugin-sdk";
import { WORKSPACE_CAPABILITY, type WorkspaceCapability } from "@parel/workspace";

export interface ProcessHandle {
	id: string;
	pid: number;
	command: string;
	cwd?: string;
	stdoutPath: string;
	stderrPath: string;
	startedAt: string;
	status: "running" | "stopped" | "unknown";
}

export interface ProcessTail {
	stdout: string;
	stderr: string;
	stdoutPath: string;
	stderrPath: string;
}

export interface ProcessCapability {
	start(
		command: string,
		opts?: { cwd?: string; envs?: Record<string, string>; timeoutMs?: number },
	): Promise<ProcessHandle>;
	list(): Promise<ProcessHandle[]>;
	tail(processId: string, opts?: { maxBytes?: number }): Promise<ProcessTail>;
	stop(processId: string): Promise<{ stopped: boolean; process: ProcessHandle }>;
}

interface StartProcessParams {
	command?: unknown;
	path?: unknown;
	timeoutMs?: unknown;
}

interface ProcessIdParams {
	processId?: unknown;
	maxBytes?: unknown;
}

const DEFAULT_TAIL_BYTES = 32 * 1024;

function numericParam(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : undefined;
}

function requiredString(value: unknown, name: string): string {
	if (typeof value !== "string" || !value.trim()) {
		throw new Error(`${name} must be a non-empty string`);
	}
	return value;
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

function logRefs(process: Pick<ProcessHandle, "stdoutPath" | "stderrPath">): ToolContentRef[] {
	return [
		{ type: "sandbox_path", path: process.stdoutPath, mediaType: "text/plain" },
		{ type: "sandbox_path", path: process.stderrPath, mediaType: "text/plain" },
	];
}

function tailContent(tail: ProcessTail): string {
	const sections: string[] = [];
	sections.push(tail.stdout ? `stdout:\n${tail.stdout}` : "stdout: <empty>");
	sections.push(tail.stderr ? `stderr:\n${tail.stderr}` : "stderr: <empty>");
	return sections.join("\n\n");
}

export default definePlugin({
	name: "@parel/process-tools",
	version: "0.1.0",
	provides: { tools: true },
	requires: { capabilities: [WORKSPACE_CAPABILITY, "process"] },

	async setup(ctx) {
		const workspace = ctx.require<WorkspaceCapability>(WORKSPACE_CAPABILITY);
		const processes = ctx.require<ProcessCapability>("process");

		async function resolveCwd(input: unknown) {
			const root = await workspace.root();
			const relative = relativePath(input, ".");
			return { relative, absolute: workspacePath(root, relative) };
		}

		ctx.tool(
			{
				name: "workspace_start_process",
				description: "Start a background process from a workspace-relative directory.",
				parameters: {
					type: "object",
					properties: {
						command: { type: "string", description: "Shell command to start in the background." },
						path: { type: "string", description: "Optional workspace-relative working directory." },
						timeoutMs: { type: "number", description: "Optional provider command timeout in ms." },
					},
					required: ["command"],
				},
				scheduling: { defaultMode: "exclusive" },
			},
			async (params: StartProcessParams): Promise<ToolOutput> => {
				const command = requiredString(params.command, "command");
				const cwd = await resolveCwd(params.path);
				const process = await processes.start(command, {
					cwd: cwd.absolute,
					...(numericParam(params.timeoutMs) ? { timeoutMs: numericParam(params.timeoutMs) } : {}),
				});
				return {
					content: [
						`Started process ${process.id} (pid ${process.pid}) in ${cwd.relative}.`,
						`stdout: ${process.stdoutPath}`,
						`stderr: ${process.stderrPath}`,
					].join("\n"),
					refs: logRefs(process),
				};
			},
		);

		ctx.tool(
			{
				name: "workspace_list_processes",
				description: "List background processes owned by this session.",
				parameters: { type: "object", properties: {} },
				scheduling: { defaultMode: "parallel" },
			},
			async (): Promise<string> => JSON.stringify(await processes.list(), null, 2),
			{ scheduling: { defaultMode: "parallel" }, isConcurrencySafe: () => true },
		);

		ctx.tool(
			{
				name: "workspace_tail_process",
				description: "Tail stdout and stderr for a background process.",
				parameters: {
					type: "object",
					properties: {
						processId: {
							type: "string",
							description: "Process id returned by workspace_start_process.",
						},
						maxBytes: { type: "number", description: "Optional bytes per stream." },
					},
					required: ["processId"],
				},
				scheduling: { defaultMode: "parallel" },
			},
			async (params: ProcessIdParams): Promise<ToolOutput> => {
				const processId = requiredString(params.processId, "processId");
				const maxBytes = numericParam(params.maxBytes) ?? DEFAULT_TAIL_BYTES;
				const tail = await processes.tail(processId, { maxBytes });
				return {
					content: tailContent(tail),
					refs: [
						{ type: "sandbox_path", path: tail.stdoutPath, mediaType: "text/plain" },
						{ type: "sandbox_path", path: tail.stderrPath, mediaType: "text/plain" },
					],
				};
			},
			{ scheduling: { defaultMode: "parallel" }, isConcurrencySafe: () => true },
		);

		ctx.tool(
			{
				name: "workspace_stop_process",
				description: "Stop a background process by id.",
				parameters: {
					type: "object",
					properties: {
						processId: {
							type: "string",
							description: "Process id returned by workspace_start_process.",
						},
					},
					required: ["processId"],
				},
				scheduling: { defaultMode: "exclusive" },
			},
			async (params: ProcessIdParams): Promise<string> => {
				const processId = requiredString(params.processId, "processId");
				const result = await processes.stop(processId);
				return result.stopped
					? `Stopped process ${processId}.`
					: `Process ${processId} was not running.`;
			},
		);
	},
});
