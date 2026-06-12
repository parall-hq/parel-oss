import { definePlugin, HookPriority, LifecycleEvent } from "@parel/plugin-sdk";

interface CodingAgentConfig {
	name?: string;
	extraInstructions?: string;
	enableForkGuidance?: boolean;
	enableProcessGuidance?: boolean;
	enablePortGuidance?: boolean;
	enableGitGuidance?: boolean;
	enableApprovalGuidance?: boolean;
}

function boolConfig(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}

function buildProfile(config: CodingAgentConfig): string {
	const name =
		typeof config.name === "string" && config.name.trim()
			? config.name.trim()
			: "PAREL coding agent";
	const sections: string[] = [
		`You are ${name}, a coding agent running on PAREL.`,
		"Work directly in the bound workspace. Prefer inspecting the current state before editing.",
		"Use workspace-relative file, search, edit, git, shell, process, and port tools when they are available. Use file-finding/search tools before assuming paths. Do not invent file contents or command results.",
		"Keep changes scoped to the user request and preserve unrelated worktree changes.",
		"For file edits, prefer exact replacement, unified patches, or focused writes. Re-read affected files when context matters.",
		"Run relevant validation after code changes. If validation cannot run, report the concrete reason.",
		"Treat large outputs as summaries plus refs. Do not ask tools to dump unbounded logs into the transcript.",
	];

	if (boolConfig(config.enableForkGuidance, true)) {
		sections.push(
			"Use forked subagents for independent investigation or review work when available. A fork should inherit the current workspace and conversation state; delegate only self-contained tasks.",
		);
	}
	if (boolConfig(config.enableProcessGuidance, true)) {
		sections.push(
			"Use background process tools for dev servers and long-running watchers. Tail logs instead of restarting processes unnecessarily.",
		);
	}
	if (boolConfig(config.enablePortGuidance, true)) {
		sections.push(
			"Expose ports only for servers the user needs to inspect. Report the provider URL and keep the process id available for later stop/tail operations.",
		);
	}
	if (boolConfig(config.enableGitGuidance, true)) {
		sections.push(
			"Use git status and diff to understand local changes. Do not commit, branch, reset, or discard changes unless explicitly requested.",
		);
	}
	if (boolConfig(config.enableApprovalGuidance, true)) {
		sections.push(
			"Request approval before destructive, credential-sensitive, externally visible, or expensive actions when approval tools are available. Do not treat a pending approval as permission.",
		);
	}
	if (config.extraInstructions?.trim()) {
		sections.push(config.extraInstructions.trim());
	}

	return `<coding_agent_profile>\n${sections.join("\n")}\n</coding_agent_profile>`;
}

export default definePlugin({
	name: "@parel/coding-agent",
	version: "0.1.0",
	provides: { hooks: true },

	async setup(ctx) {
		const profile = buildProfile((ctx.config ?? {}) as CodingAgentConfig);
		ctx.hook(
			LifecycleEvent.ContextBuild,
			async (hookCtx) => ({
				action: "continue" as const,
				mutations: {
					system: hookCtx.system ? `${hookCtx.system}\n\n${profile}` : profile,
				},
			}),
			{ priority: HookPriority.Early },
		);
	},
});
