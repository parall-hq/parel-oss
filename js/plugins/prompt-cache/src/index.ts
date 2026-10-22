import {
	definePlugin,
	HookPriority,
	LifecycleEvent,
	type Message,
	type ModelCallParams,
	type ParelPlugin,
	type PromptCacheHint,
} from "@parel/plugin-sdk";
import manifest from "../parel.plugin.json" with { type: "json" };

/**
 * Filled in under whatever hint the tail message already carries. Priority 70
 * ranks above the runtime's system (50) and tools (40) defaults, so a provider
 * breakpoint cap never drops the tail; on Anthropic (4 breakpoints) all three fit.
 */
const TAIL_HINT: PromptCacheHint = { eligible: true, priority: 70 };

/** The last non-system message with an id: the runtime plans message breakpoints by id. */
function tailIndex(messages: readonly Message[]): number {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message?.role !== "system" && message?.id) return i;
	}
	return -1;
}

/**
 * The cache-hinted request, or `undefined` when nothing changes. Global cache
 * opt-outs turn the plugin off; an authored breakpoint plan or a tail marked
 * `eligible: false` only stops the tail hint; an authored `prompt_cache_key`
 * (even null or empty) is kept.
 */
function withPromptCache(
	params: ModelCallParams,
	sessionId: string | undefined,
): ModelCallParams | undefined {
	const cache = params.promptCache;
	if (cache?.enabled === false || cache?.mode === "off") return undefined;
	if (!Array.isArray(params.messages)) return undefined;

	let next = params;

	// OpenAI-family adapters pass providerOptions.openai through to the request;
	// other adapters ignore it. One key per session keeps its calls on one cache.
	const openai = params.providerOptions?.openai;
	if (sessionId && openai?.prompt_cache_key === undefined) {
		next = {
			...next,
			providerOptions: {
				...params.providerOptions,
				openai: { ...openai, prompt_cache_key: `parel:${sessionId}` },
			},
		};
	}

	// Adapters with explicit breakpoints (Anthropic) mark the end of the history,
	// so the next call reads everything before its new messages from cache.
	const index = tailIndex(params.messages);
	const tail = params.messages[index];
	const planned = Array.isArray(cache?.breakpoints) && cache.breakpoints.length > 0;
	if (tail && !planned && tail.cacheHint?.eligible !== false) {
		const messages = [...params.messages];
		messages[index] = { ...tail, cacheHint: { ...TAIL_HINT, ...tail.cacheHint } };
		next = { ...next, messages };
	}

	return next === params ? undefined : next;
}

export default definePlugin({
	name: "@parel/prompt-cache",
	execution: manifest.execution as ParelPlugin["execution"],

	async setup(ctx) {
		// Late: the tail must be the last message after other plugins' model:before edits.
		ctx.hook(
			LifecycleEvent.ModelBefore,
			async (hookCtx) => {
				const modelParams = withPromptCache(hookCtx.modelParams, hookCtx.session?.id);
				if (modelParams) return { action: "continue" as const, mutations: { modelParams } };
			},
			{ priority: HookPriority.Late },
		);
	},
});
