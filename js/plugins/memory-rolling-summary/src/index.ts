import type { Message, MessagePart } from "@parel/plugin-sdk";
import { definePlugin, LifecycleEvent, type ParelPlugin } from "@parel/plugin-sdk";
import manifest from "../parel.plugin.json" with { type: "json" };

// @parel/memory-rolling-summary — keep the model's context window bounded by
// rolling older messages into a running summary.
//
// Two cooperating hooks:
//  - context:build  PRUNES the window: drops the already-summarized leading
//                   messages from the model call and injects the running summary
//                   into the system prompt. This is what actually shrinks tokens.
//  - turn:end       ROLLS the summary forward: when the un-summarized tail grows
//                   past the threshold, it folds everything older than the last
//                   `keep_recent_messages` into the *existing* summary with one
//                   model call, and advances a high-water mark.
//
// State (store key STATE_KEY): { summary, summarizedCount }. `summarizedCount` is
// a prefix length over the session's append-only message history, so it stays
// valid across turns — history only grows at the tail, and context:build always
// receives the full history (we prune only a per-call view of it, never the
// persisted record).

const STATE_KEY = "rolling_summary";

interface RollingState {
	summary: string;
	/** Number of leading history messages already folded into `summary`. */
	summarizedCount: number;
}

function textOf(part: MessagePart): string {
	// Never surface provider-internal content: a summary is injected back as a
	// chat-visible system prompt, so hidden/trace parts (e.g. provider reasoning /
	// chain-of-thought) must not leak into it. `reasoning` parts are excluded
	// entirely — they are model-internal and not useful conversational substance.
	if (part.visibility === "hidden" || part.visibility === "trace") return "";
	if (part.type === "text") return part.text;
	if (part.type === "tool_call")
		return `[tool ${part.toolCall.name}(${JSON.stringify(part.toolCall.arguments)})]`;
	if (part.type === "tool_result")
		return `[result${part.isError ? " error" : ""}: ${part.content}]`;
	// Visible non-text content can't be summarized losslessly, but the original
	// message is pruned once summarized — leave a placeholder so attachments are
	// represented in the summary rather than silently disappearing.
	if (part.type === "image") return "[image]";
	if (part.type === "file") return `[file${part.filename ? ` ${part.filename}` : ""}]`;
	if (part.type === "source") return `[source: ${part.sourceType}]`;
	return ""; // reasoning — model-internal, excluded
}

// Choose a prune boundary that never leaves the kept window starting on an
// orphan tool result — i.e. a `role: "tool"` message whose originating
// assistant `tool_call` was summarized away. Providers reject orphan tool
// results, so snap forward past any leading tool messages (folding them into the
// summary too). Returns a count in [desired, messages.length].
function safeDropCount(messages: Message[], desired: number): number {
	let i = Math.min(Math.max(desired, 0), messages.length);
	while (i < messages.length && messages[i].role === "tool") i++;
	return i;
}

function renderMessage(m: Message): string {
	const body = m.parts.map(textOf).filter(Boolean).join(" ");
	return `${m.role}: ${body}`;
}

// Heuristic window-size estimate (~4 chars/token). Only used to decide *when* to
// compact, so an approximation is fine.
function estimateTokens(messages: Message[]): number {
	let chars = 0;
	for (const m of messages) {
		for (const p of m.parts) chars += textOf(p).length;
	}
	return Math.ceil(chars / 4);
}

export default definePlugin({
	name: "@parel/memory-rolling-summary",
	execution: manifest.execution as ParelPlugin["execution"],

	async setup(ctx) {
		const maxContextTokens = (ctx.config.max_context_tokens as number) ?? 100_000;
		const compactAt = (ctx.config.compact_at as number) ?? 0.8;
		const threshold = maxContextTokens * compactAt;
		const keepRecent = Math.max(2, (ctx.config.keep_recent_messages as number) ?? 12);

		// Full message history seen at the last context:build, so turn:end — whose
		// event context carries no messages — can read it.
		let lastMessages: Message[] = [];

		ctx.hook(LifecycleEvent.ContextBuild, async (hookCtx) => {
			lastMessages = hookCtx.messages;

			const state = await ctx.store.get<RollingState>(STATE_KEY);
			if (!state?.summary || state.summarizedCount <= 0) return;

			// Drop the summarized prefix; keep the rest verbatim. Clamp defensively
			// in case the visible history is shorter than the recorded mark.
			const drop = Math.min(state.summarizedCount, hookCtx.messages.length);
			const kept = hookCtx.messages.slice(drop);

			return {
				action: "continue" as const,
				mutations: {
					system: `${hookCtx.system}\n\n<conversation-summary>\n${state.summary}\n</conversation-summary>`,
					messages: kept,
				},
			};
		});

		ctx.hook(LifecycleEvent.TurnEnd, async () => {
			const state = (await ctx.store.get<RollingState>(STATE_KEY)) ?? {
				summary: "",
				summarizedCount: 0,
			};

			// Only the not-yet-summarized tail counts toward the window budget.
			const tail = lastMessages.slice(state.summarizedCount);
			if (estimateTokens(tail) < threshold) return;

			// Fold everything older than the most recent `keepRecent` messages, but
			// snap the boundary so we never split a tool call from its result.
			const targetCount = safeDropCount(lastMessages, lastMessages.length - keepRecent);
			if (targetCount <= state.summarizedCount) return; // nothing new aged out yet

			const toFold = lastMessages.slice(state.summarizedCount, targetCount);
			if (toFold.length === 0) return;

			const conversation = toFold.map(renderMessage).join("\n");
			const prior = state.summary ? `Existing summary so far:\n${state.summary}\n\n` : "";

			try {
				let next = "";
				for await (const chunk of ctx.model.chat({
					messages: [
						{
							role: "user",
							parts: [
								{
									type: "text",
									text:
										`You maintain a running summary of a long agent conversation.\n${prior}` +
										`New messages to fold into the summary:\n${conversation}\n\n` +
										"Rewrite the summary so it stays concise but preserves key decisions, " +
										"established facts, constraints, open questions, and pending action items. " +
										"Output only the updated summary.",
									visibility: "chat",
								},
							],
						},
					],
					maxTokens: 2000,
				})) {
					if (chunk.type === "text_delta" && chunk.text) next += chunk.text;
				}

				next = next.trim();
				if (!next) return; // keep prior state rather than wipe the summary

				await ctx.store.set<RollingState>(STATE_KEY, {
					summary: next,
					summarizedCount: targetCount,
				});
				ctx.log.info(
					`Compacted ${toFold.length} message(s); window now ~${keepRecent} recent + summary`,
				);
			} catch {
				ctx.log.warn("Memory compaction skipped — model capability unavailable");
			}
		});
	},
});
