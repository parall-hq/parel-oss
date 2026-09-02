import type {
	HookHandler,
	HookOptions,
	LifecycleEventType,
	TranscriptReader,
} from "./lifecycle.js";
import type {
	InputQueue,
	InstanceInfo,
	InstanceStore,
	MessagePart,
	ModelCallParams,
	ModelCapabilities,
	ModelStreamChunk,
	NormalizeHandler,
	NormalizeRegistrationOptions,
	PluginLogger,
	SessionState,
	SessionStore,
	ToolDefinition,
	ToolHandler,
	ToolRegistrationOptions,
} from "./session.js";

// --- Slash commands ---
// A `/name args` typed by the user is dispatched to the plugin that registered
// `name` instead of being materialized as a transcript message. The host decides
// "is this a command" from the manifest's static `provides.commands`, so a
// registration must be declared there. Design: parel-mono docs/slash-commands.md.

/** Static description of a slash command a plugin exposes (`/name args`). */
export interface CommandDefinition {
	/** Name as typed after the slash (`compact`). Lowercase, `[a-z][a-z0-9_-]*`. */
	name: string;
	/** One line shown by `/help` and the session's command listing. */
	description: string;
	/** Free-form argument help; the runtime does not validate arguments. */
	args?: { description: string };
}

/** What a command handler sees. `ctx.model` and `ctx.store` from setup are reachable by closure. */
export interface CommandContext {
	session: Readonly<SessionState>;
	store: SessionStore;
	log: PluginLogger;
	/** Read handle over the transcript path; absent on hosts that do not serve one. */
	transcript?: TranscriptReader;
}

/**
 * Outcome of a command. `reply` is shown to the user and never reaches the
 * model or the transcript. `prompt`, when set, is materialized as the user
 * message of a new turn (the command expanded into a prompt).
 */
export interface CommandResult {
	reply?: string;
	prompt?: string | MessagePart[];
}

export type CommandHandler = (
	args: string,
	ctx: CommandContext,
	// biome-ignore lint/suspicious/noConfusingVoidType: a handler may intentionally return nothing
) => Promise<CommandResult | void>;

export interface ParelPlugin {
	name: string;
	version: string;
	/** Capabilities/tools/hooks this plugin contributes (used for dependency resolution). */
	provides?: PluginManifest["provides"];
	/** Plugins/capabilities/permissions this plugin depends on (enforced at load time). */
	requires?: PluginManifest["requires"];
	/** Execution snapshot/branch policy metadata declared by the plugin. */
	execution?: PluginManifest["execution"];
	/** Opt-in consumption declarations (e.g. per-turn invocation context). */
	consumes?: PluginManifest["consumes"];
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
	/**
	 * Instance-scoped bucket shared across every session of the same agent
	 * instance (sandbox handles, long-term memory). `undefined` on hosts
	 * without instance storage — probe explicitly and degrade honestly; the
	 * host never silently substitutes the per-session store. Hook/tool
	 * handlers reach it by closure capture from setup.
	 */
	instanceStore?: InstanceStore;
	/** Identity of the owning instance; `undefined` on hosts that predate it. */
	instance?: InstanceInfo;
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

	/**
	 * Register a slash command (`/name args`) the user can type into the session.
	 * The name must be declared in the manifest's `provides.commands`; hosts treat
	 * an undeclared registration as a setup error. Optional so plugins built
	 * against this SDK keep loading on hosts that predate the capability — guard
	 * the call with `ctx.command?.(...)`. Design: parel-mono docs/slash-commands.md.
	 */
	command?(definition: CommandDefinition, handler: CommandHandler): void;

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
		/** Slash commands this plugin registers via `ctx.command` (e.g. "compact"). Declaration is authorization. */
		commands?: string[];
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
	/**
	 * Opt-in consumption declarations. `invocationContext: true` lets this plugin
	 * receive the per-turn invocation context on its tool contexts
	 * (`ToolHandlerContext.invocationContext`). Default off — declaring it is treated as
	 * authorization (the agent author opted in by adding the plugin). Hook-context
	 * delivery for policy/channel plugins is a later phase. Design: docs/invocation-context.md §5.
	 */
	consumes?: {
		invocationContext?: boolean;
		/**
		 * `"lazy"`: this plugin reads history through `hookCtx.transcript` and does
		 * not need the full `messages` array pushed on every hook dispatch. The host
		 * drops the eager push for an event only when every subscriber declared it.
		 */
		transcript?: "lazy";
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
