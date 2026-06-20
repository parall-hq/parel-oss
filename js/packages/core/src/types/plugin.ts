import type { HookHandler, HookOptions, LifecycleEventType } from "./lifecycle.js";
import type {
	InputQueue,
	ModelCallParams,
	ModelCapabilities,
	ModelStreamChunk,
	NormalizeHandler,
	NormalizeRegistrationOptions,
	PluginLogger,
	SessionStore,
	ToolDefinition,
	ToolHandler,
	ToolRegistrationOptions,
} from "./session.js";

export interface ParelPlugin {
	name: string;
	version: string;
	/** Capabilities/tools/hooks this plugin contributes (used for dependency resolution). */
	provides?: PluginManifest["provides"];
	/** Plugins/capabilities/permissions this plugin depends on (enforced at load time). */
	requires?: PluginManifest["requires"];
	/** Execution snapshot/branch policy metadata declared by the plugin. */
	execution?: PluginManifest["execution"];
	setup(ctx: PluginContext): Promise<void>;
	teardown?(ctx: PluginContext): Promise<void>;
}

export interface ModelGatewayAccess {
	chat(params: ModelCallParams, provider?: string): AsyncIterable<ModelStreamChunk>;
	capabilities(provider?: string): ModelCapabilities;
	listProviders(): string[];
}

export interface PluginContext {
	config: Record<string, unknown>;
	store: SessionStore;
	inputs: InputQueue;
	log: PluginLogger;
	model: ModelGatewayAccess;

	hook<E extends LifecycleEventType>(
		event: E,
		handler: HookHandler<E>,
		options?: HookOptions,
	): void;

	tool(definition: ToolDefinition, handler: ToolHandler, options?: ToolRegistrationOptions): void;

	/**
	 * Register a normalizer that turns inbound platform inputs of the given types
	 * (e.g. "async_callback") into canonical transcript messages at intake.
	 * Optional so plugins built against this SDK keep loading on hosts that predate
	 * the capability — guard the call with `ctx.normalize?.(...)`.
	 */
	normalize?(
		types: string[],
		handler: NormalizeHandler,
		options?: NormalizeRegistrationOptions,
	): void;

	provide<T = unknown>(name: string, implementation: T): void;
	require<T = unknown>(name: string): T;

	interrupt(): void;
}

export interface ModelAdapter {
	provider: string;
	chat(params: ModelCallParams): AsyncIterable<ModelStreamChunk>;
	capabilities(): ModelCapabilities;
}

export interface PluginManifest {
	name: string;
	version: string;
	description?: string;
	provides?: {
		hooks?: boolean;
		tools?: boolean;
		/** Input types this plugin can normalize into transcript messages (e.g. "async_callback"). */
		normalize?: string[];
		capabilities?: string[];
	};
	requires?: {
		plugins?: string[];
		capabilities?: string[];
		permissions?: {
			network?: boolean;
			store?: boolean;
			model?: boolean;
			inputs?: boolean;
		};
		/**
		 * Declares which `config` fields are secrets, keyed by field name (e.g.
		 * `apiKey`) — the fields' nature, not their source. Values are bound via
		 * `${NAME}` references in the agent config (see `secret-refs.ts`) and
		 * substituted by the host before `setup` runs; the plugin reads plain
		 * resolved values. Hosts use the declaration to reject literal values in
		 * these fields at deploy time, validate required ones before `setup`, and
		 * redact them from logs/snapshots. `description` is surfaced in credential
		 * UIs and error messages; `required` defaults to true.
		 */
		secrets?: Record<string, { description: string; required?: boolean }>;
	};
	execution?: {
		snapshot?: {
			store?: "copy" | "redact" | "reset" | "custom";
			sandbox?: "copy" | "reset" | "unsupported" | "custom";
			sideEffects?: "reference" | "require_approval" | "deny_replay";
		};
	};
	config?: Record<string, unknown>;
}
