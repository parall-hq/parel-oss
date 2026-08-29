import type { HookContext, Message, MessagePart, TranscriptReader } from "@parel/plugin-sdk";
import { definePlugin, LifecycleEvent, type ParelPlugin } from "@parel/plugin-sdk";
import manifest from "../parel.plugin.json" with { type: "json" };

// @parel/memory-rolling-summary — keep the model's context window bounded by
// rolling older messages into a running summary.
//
// Three cooperating hooks:
//  - context:build  PRUNES the window: reads only the not-yet-summarized tail of
//                   the transcript path and injects the running summary into the
//                   system prompt. This is what actually shrinks tokens.
//  - step:end /     ROLL the summary forward: when the un-summarized tail grows
//    turn:end       past the threshold, fold everything older than the last
//                   `keep_recent_messages` into the *existing* summary with one
//                   model call, and advance the high-water mark. Checking at step
//                   boundaries too means a long agentic turn cannot blow the
//                   window between turn ends.
//
// Coordinates are transcript PATH coordinates (`message.seq`), not array
// positions: a pointer-forked session's path continues its parent's seqs, so a
// count would be wrong there. Messages without a seq (older hosts, tests) fall
// back to their 1-based position. State (store key STATE_KEY):
// { summary, summarizedUptoSeq } — the legacy `summarizedCount` field is read
// as a seq (equal under contiguous numbering) so existing sessions carry over.
//
// The plugin declares `consumes.transcript: "lazy"`: on hosts that serve the
// transcript reader (hookCtx.transcript) it pulls just the tail it needs instead
// of receiving the whole history on every dispatch; on older hosts it falls back
// to the pushed `messages` array. Either way it only ever shapes a per-call view
// of the history — the persisted transcript is never touched.

const STATE_KEY = "rolling_summary";

interface RollingState {
	summary: string;
	/** Path coordinate up to which history is folded into `summary`. */
	summarizedUptoSeq?: number;
	/** Legacy field (pre path-coordinate state): a prefix length, read as a seq. */
	summarizedCount?: number;
}

function summarizedUpto(state: RollingState | null | undefined): number {
	return state?.summarizedUptoSeq ?? state?.summarizedCount ?? 0;
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

/** Path coordinate of a message: its seq, else its 1-based position in the pushed array. */
function seqAt(message: Message, position: number): number {
	return message.seq ?? position + 1;
}

/** The not-yet-summarized tail (seq > upto): pulled through the reader when the host serves one, else sliced from the pushed array. */
async function readTail(
	hookCtx: { messages?: Message[]; transcript?: TranscriptReader },
	upto: number,
): Promise<Message[]> {
	if (hookCtx.transcript) return hookCtx.transcript.read({ fromSeq: upto + 1 });
	return (hookCtx.messages ?? []).filter((message, position) => seqAt(message, position) > upto);
}

export default definePlugin({
	name: "@parel/memory-rolling-summary",
	execution: manifest.execution as ParelPlugin["execution"],
	consumes: manifest.consumes as ParelPlugin["consumes"],

	async setup(ctx) {
		const compactAt = (ctx.config.compact_at as number) ?? 0.8;
		const keepRecent = Math.max(2, (ctx.config.keep_recent_messages as number) ?? 12);
		// Budget fact: an explicit config wins; else the adapter's advertised window
		// (0 = unknown on *-compatible endpoints); else a conservative default.
		const maxContextTokens = (() => {
			const configured = ctx.config.max_context_tokens as number | undefined;
			if (typeof configured === "number" && configured > 0) return configured;
			try {
				const advertised = ctx.model.capabilities().maxContextTokens;
				if (typeof advertised === "number" && advertised > 0) return advertised;
			} catch {
				// No resolvable route yet — fall through to the default.
			}
			return 100_000;
		})();
		const threshold = maxContextTokens * compactAt;

		// What the last context:build saw: the reader (lazy hosts) or the pushed
		// history (legacy hosts). The fold hooks' contexts carry no messages.
		let lastReader: TranscriptReader | undefined;
		let lastMessages: Message[] = [];

		ctx.hook(LifecycleEvent.ContextBuild, async (hookCtx) => {
			const lazyCtx = hookCtx as HookContext<"context:build"> & {
				transcript?: TranscriptReader;
			};
			lastReader = lazyCtx.transcript;
			lastMessages = lazyCtx.messages ?? [];

			const state = await ctx.store.get<RollingState>(STATE_KEY);
			const upto = state?.summary ? summarizedUpto(state) : 0;
			const tail = await readTail(lazyCtx, upto);

			if (!state?.summary || upto <= 0) {
				// Nothing summarized yet, nothing to prune. A lazy host did not push
				// `messages`, so the window is what we just read from the path.
				return lazyCtx.messages === undefined
					? { action: "continue" as const, mutations: { messages: tail } }
					: undefined;
			}

			// Drop the summarized prefix; keep the tail verbatim.
			return {
				action: "continue" as const,
				mutations: {
					system: `${hookCtx.system}\n\n<conversation-summary>\n${state.summary}\n</conversation-summary>`,
					messages: tail,
				},
			};
		});

		const rollForward = async () => {
			const state = (await ctx.store.get<RollingState>(STATE_KEY)) ?? { summary: "" };
			const upto = summarizedUpto(state);

			// Only the not-yet-summarized tail counts toward the window budget.
			const tail = lastReader
				? await lastReader.read({ fromSeq: upto + 1 })
				: lastMessages.filter((message, position) => seqAt(message, position) > upto);
			if (estimateTokens(tail) < threshold) return;

			// Fold everything older than the most recent `keepRecent` messages, but
			// snap the boundary so we never split a tool call from its result.
			const dropCount = safeDropCount(tail, tail.length - keepRecent);
			if (dropCount <= 0) return; // nothing new aged out yet
			const toFold = tail.slice(0, dropCount);
			const targetSeq = seqAt(toFold[toFold.length - 1], upto + dropCount - 1);

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
					summarizedUptoSeq: targetSeq,
				});
				ctx.log.info(
					`Compacted ${toFold.length} message(s) up to seq ${targetSeq}; window now ~${keepRecent} recent + summary`,
				);
			} catch {
				ctx.log.warn("Memory compaction skipped — model capability unavailable");
			}
		};

		// Step boundaries too: a long agentic turn must not blow the window
		// between turn ends. Cheap when under threshold (one estimate, no model).
		ctx.hook(LifecycleEvent.StepEnd, rollForward);
		ctx.hook(LifecycleEvent.TurnEnd, rollForward);
	},
});
