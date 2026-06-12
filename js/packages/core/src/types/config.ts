export interface AgentConfig {
	version: string;
	agent?: AgentIdentity;
	model: ModelConfig;
	plugins: PluginDeclaration[];
	runtime: RuntimeConfig;
}

export interface AgentIdentity {
	name: string;
}

export interface ModelConfig {
	provider: string;
	model: string;
	config?: Record<string, unknown>;
}

export type PluginDeclaration = string | PluginWithConfig | PluginFullForm;

export interface PluginWithConfig {
	[pluginName: string]: Record<string, unknown>;
}

export interface PluginFullForm {
	plugin: string;
	/**
	 * Optional semver range. A runtime may resolve this to an exact version +
	 * integrity at deploy time and freeze it; omitted means "latest at resolution
	 * time". Purely declarative here — `@parel/core` does not resolve it.
	 */
	version?: string;
	/**
	 * Optional deploy-time source. `path` sources are consumed by the CLI, packed
	 * into immutable artifacts, and frozen by the hosted runtime. Runtime sessions
	 * never load from this local path directly.
	 */
	source?: PluginSource;
	config?: Record<string, unknown>;
}

export type PluginSource = { type: "path"; path: string };

export interface RuntimeConfig {
	maxTurns?: number;
	maxSteps?: number;
	maxParallelToolCalls?: number;
	toolResultMaxBytes?: number;
	durability?: "event-sourced" | "ephemeral";
	checkpointInterval?: number;
	reasoning?: {
		enabled: boolean;
		budgetTokens?: number;
	};
}

export interface ResolvedPlugin {
	packageName: string;
	config: Record<string, unknown>;
}
