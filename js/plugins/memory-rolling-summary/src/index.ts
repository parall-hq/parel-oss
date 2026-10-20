import type {
	HookContext,
	HookTurnInfo,
	Message,
	MessagePart,
	TokenUsage,
	TranscriptReader,
} from "@parel/plugin-sdk";
import { definePlugin, LifecycleEvent, type ParelPlugin } from "@parel/plugin-sdk";
import manifest from "../parel.plugin.json" with { type: "json" };

// @parel/memory-rolling-summary — keep the model's context window bounded by
// rolling older messages into a running summary.
//
// Four cooperating hooks:
//  - context:build  PRUNES the window: reads only the not-yet-summarized tail of
//                   the transcript path and injects the running summary into the
//                   system prompt. This is what actually shrinks tokens.
//  - model:after    MEASURES the window: records the input tokens the model
//                   reported for the call (input + cache read + cache write).
//  - step:end /     ROLL the summary forward: when the window reaches the
//    turn:end       threshold, fold everything older than the most recent
//                   `keep_recent_tokens` into the *existing* summary with one
//                   model call, and advance the high-water mark. The window size
//                   is the last call's reported input plus an estimate of what
//                   the transcript gained since; with no reported number yet, an
//                   estimate of the tail. Checking at step boundaries too means a
//                   long agentic turn cannot blow the window between turn ends.
//                   A failed automatic fold is logged and waits for the next turn.
//  - /compact       The same fold, on demand and regardless of the threshold,
//    [focus]        typed by the user into the session (slash command). An
//                   optional focus text steers what the summary keeps.
//
// Coordinates are transcript PATH coordinates (`message.seq`), not array
// positions: a pointer-forked session's path continues its parent's seqs, so a
// count would be wrong there. Messages without a seq (older hosts, tests) fall
// back to their 1-based position. State (store key STATE_KEY):
// { summary, summarizedUptoSeq, failedTurnId? } — the legacy `summarizedCount`
// field is read as a seq (equal under contiguous numbering) so existing sessions
// carry over. The measurement lives under its own key (LAST_CALL_KEY), in the
// store rather than memory because a host may set the plugin up again per step.
//
// The plugin declares `consumes.transcript: "lazy"`: on hosts that serve the
// transcript reader (hookCtx.transcript) it pulls just the tail it needs instead
// of receiving the whole history on every dispatch; on older hosts it falls back
// to the pushed `messages` array. Either way it only ever shapes a per-call view
// of the history — the persisted transcript is never touched.

const STATE_KEY = "rolling_summary";
const LAST_CALL_KEY = "rolling_summary_last_call";

const DEFAULT_KEEP_RECENT_TOKENS = 20_000;
const DEFAULT_SUMMARY_MAX_TOKENS = 16_000;
// Summarizer input limits, in characters: the head of a bulky payload carries
// its gist. Prose carries decisions, so it keeps more than tool output.
const TOOL_RESULT_MAX_CHARS = 2_000;
const TOOL_ARGS_MAX_CHARS = 2_000;
const TEXT_MAX_CHARS = 6_000;

interface RollingState {
	summary: string;
	/** Path coordinate up to which history is folded into `summary`. */
	summarizedUptoSeq?: number;
	/** Legacy field (pre path-coordinate state): a prefix length, read as a seq. */
	summarizedCount?: number;
	/** Turn whose automatic fold failed; automatic folds wait for the next turn. */
	failedTurnId?: string;
}

/** What the last model call reported it was sent. */
interface LastCall {
	/** Input + cache read + cache write tokens. */
	inputTokens: number;
	/** Path coordinate of the newest transcript message that call saw. */
	uptoSeq?: number;
}

/** A transcript message with its path coordinate. */
interface Entry {
	message: Message;
	seq: number;
}

function summarizedUpto(state: RollingState | null | undefined): number {
	return state?.summarizedUptoSeq ?? state?.summarizedCount ?? 0;
}

/** Keep the head of a long payload and say how much was cut. */
function clip(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, max)} [truncated ${text.length - max} chars]`;
}

/**
 * Model-visible text of a part. `forSummary` clips bulky payloads (tool
 * results, tool arguments, long prose) for the summarizer's input; token
 * estimates read the full text.
 */
function textOf(part: MessagePart, forSummary = false): string {
	const cut = (text: string, max: number) => (forSummary ? clip(text, max) : text);
	// Never surface provider-internal content: a summary is injected back as a
	// chat-visible system prompt, so hidden/trace parts (e.g. provider reasoning /
	// chain-of-thought) must not leak into it. `reasoning` parts are excluded
	// entirely — they are model-internal and not useful conversational substance.
	if (part.visibility === "hidden" || part.visibility === "trace") return "";
	if (part.type === "text") return cut(part.text, TEXT_MAX_CHARS);
	if (part.type === "tool_call")
		return `[tool ${part.toolCall.name}(${cut(JSON.stringify(part.toolCall.arguments) ?? "", TOOL_ARGS_MAX_CHARS)})]`;
	if (part.type === "tool_result")
		return `[result${part.isError ? " error" : ""}: ${cut(part.content, TOOL_RESULT_MAX_CHARS)}]`;
	// Visible non-text content can't be summarized losslessly, but the original
	// message is pruned once summarized — leave a placeholder so attachments are
	// represented in the summary rather than silently disappearing.
	if (part.type === "image") return "[image]";
	if (part.type === "file") return `[file${part.filename ? ` ${part.filename}` : ""}]`;
	if (part.type === "source") return `[source: ${part.sourceType}]`;
	return ""; // reasoning — model-internal, excluded
}

function renderMessage(m: Message): string {
	const body = m.parts
		.map((part) => textOf(part, true))
		.filter(Boolean)
		.join(" ");
	return `${m.role}: ${body}`;
}

// CJK ideographs, kana and hangul run about one token per character; other text
// about four characters per token. A flat chars/4 undercounts Chinese ~2.5x.
const CJK_CHAR =
	/[\u3000-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]/g;

/** Estimated tokens of a message. Used for the kept window, and for the trigger only until a model call reports its real input. */
function estimateTokens(message: Message): number {
	let tokens = 0;
	for (const part of message.parts) {
		const text = textOf(part);
		const cjk = text.match(CJK_CHAR)?.length ?? 0;
		tokens += cjk + Math.ceil((text.length - cjk) / 4);
	}
	return tokens;
}

function sumTokens(entries: Entry[]): number {
	let tokens = 0;
	for (const entry of entries) tokens += estimateTokens(entry.message);
	return tokens;
}

/** Input a call was sent: non-cached + cache read + cache write. 0 = nothing reported. */
function inputTokensOf(usage: TokenUsage | undefined): number {
	if (!usage) return 0;
	return (usage.inputTokens ?? 0) + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
}

/**
 * How big the window is: the last call's reported input plus an estimate of
 * what the transcript gained since (a large tool result can land after a call
 * that was still under the line); with no reported number, an estimate of the
 * whole tail.
 */
function measureWindow(
	tail: Entry[],
	lastCall: LastCall | null,
): { tokens: number; reported: boolean } {
	if (!lastCall) return { tokens: sumTokens(tail), reported: false };
	const covered = lastCall.uptoSeq;
	const since = covered === undefined ? [] : tail.filter((entry) => entry.seq > covered);
	return { tokens: lastCall.inputTokens + sumTokens(since), reported: true };
}

/**
 * Where the kept window starts: walk back from the newest message until
 * `keepTokens` are covered. The kept window never starts on a tool result whose
 * call would be folded away (providers reject orphan results): the cut moves
 * forward past the results, folding them with their call — or, when that would
 * keep nothing, back to the call. Returns the number of messages to fold; 0
 * when the whole tail fits in the kept window or no safe cut exists.
 */
function cutPoint(tail: Message[], keepTokens: number): number {
	let kept = 0;
	let cut = tail.length;
	while (cut > 0 && kept < keepTokens) {
		cut--;
		kept += estimateTokens(tail[cut]);
	}
	if (cut === 0) return 0;
	let forward = cut;
	while (forward < tail.length && tail[forward].role === "tool") forward++;
	if (forward < tail.length) return forward;
	while (cut > 0 && tail[cut].role === "tool") cut--;
	return cut;
}

/** Path coordinate of a message: its seq, else its 1-based position. */
function seqAt(message: Message, position: number): number {
	return message.seq ?? position + 1;
}

/** The not-yet-summarized tail (seq > upto): pulled through the reader when the host serves one, else taken from the pushed array. */
async function readTail(
	source: { reader?: TranscriptReader; messages?: Message[] },
	upto: number,
): Promise<Entry[]> {
	if (source.reader) {
		const read = await source.reader.read({ fromSeq: upto + 1 });
		return read.map((message, index) => ({ message, seq: seqAt(message, upto + index) }));
	}
	return (source.messages ?? [])
		.map((message, position) => ({ message, seq: seqAt(message, position) }))
		.filter((entry) => entry.seq > upto);
}

function errorText(error: unknown): string {
	if (!(error instanceof Error)) return String(error);
	const code = (error as { code?: unknown }).code;
	return typeof code === "string" ? `${code}: ${error.message}` : error.message;
}

export default definePlugin({
	name: "@parel/memory-rolling-summary",
	provides: manifest.provides as ParelPlugin["provides"],
	execution: manifest.execution as ParelPlugin["execution"],
	consumes: manifest.consumes as ParelPlugin["consumes"],

	async setup(ctx) {
		const positive = (key: string): number | undefined => {
			const value = ctx.config[key];
			return typeof value === "number" && value > 0 ? value : undefined;
		};
		const compactAt = (ctx.config.compact_at as number) ?? 0.8;
		// Budget fact: an explicit config wins; else the adapter's advertised window
		// (0 = unknown on *-compatible endpoints); else a conservative default.
		const maxContextTokens =
			positive("max_context_tokens") ??
			(() => {
				try {
					const advertised = ctx.model.capabilities().maxContextTokens;
					if (typeof advertised === "number" && advertised > 0) return advertised;
				} catch {
					// No resolvable route yet — fall through to the default.
				}
				return 100_000;
			})();
		const threshold = maxContextTokens * compactAt;
		// At most half the threshold, so a fold leaves room under it.
		const keepTokens = Math.max(
			1,
			Math.min(positive("keep_recent_tokens") ?? DEFAULT_KEEP_RECENT_TOKENS, threshold / 2),
		);
		const summaryMaxTokens = positive("summary_max_tokens") ?? DEFAULT_SUMMARY_MAX_TOKENS;
		if (ctx.config.keep_recent_messages !== undefined) {
			ctx.log.warn(
				"keep_recent_messages is no longer read: the recent window is measured in tokens (keep_recent_tokens)",
			);
		}

		// What the last context:build saw: the reader (lazy hosts) or the pushed
		// history (legacy hosts), and the newest coordinate in that window — the
		// part of the transcript the following model call measures.
		let lastReader: TranscriptReader | undefined;
		let lastMessages: Message[] = [];
		let lastWindowUpto: number | undefined;

		ctx.hook(LifecycleEvent.ContextBuild, async (hookCtx) => {
			const lazyCtx = hookCtx as HookContext<"context:build"> & {
				transcript?: TranscriptReader;
			};
			lastReader = lazyCtx.transcript;
			lastMessages = lazyCtx.messages ?? [];

			const state = await ctx.store.get<RollingState>(STATE_KEY);
			const upto = state?.summary ? summarizedUpto(state) : 0;
			const tail = await readTail({ reader: lazyCtx.transcript, messages: lazyCtx.messages }, upto);
			lastWindowUpto = tail.at(-1)?.seq;
			const window = tail.map((entry) => entry.message);

			if (!state?.summary || upto <= 0) {
				// Nothing summarized yet, nothing to prune. A lazy host did not push
				// `messages`, so the window is what we just read from the path.
				return lazyCtx.messages === undefined
					? { action: "continue" as const, mutations: { messages: window } }
					: undefined;
			}

			// Drop the summarized prefix; keep the tail verbatim.
			return {
				action: "continue" as const,
				mutations: {
					system: `${hookCtx.system}\n\n<conversation-summary>\n${state.summary}\n</conversation-summary>`,
					messages: window,
				},
			};
		});

		// Each call replaces the previous measurement — including with "none": a
		// call that reported nothing must not be stood in for by an earlier one.
		// Never throws: a lost measurement only falls back to the estimate.
		ctx.hook(LifecycleEvent.ModelAfter, async (hookCtx) => {
			try {
				const inputTokens = inputTokensOf(hookCtx.modelResponse?.usage);
				if (inputTokens > 0) {
					await ctx.store.set<LastCall>(LAST_CALL_KEY, {
						inputTokens,
						...(lastWindowUpto !== undefined ? { uptoSeq: lastWindowUpto } : {}),
					});
				} else {
					await ctx.store.delete(LAST_CALL_KEY);
				}
			} catch (error) {
				ctx.log.warn(`Could not record the model call's input size: ${errorText(error)}`);
			}
		});

		/**
		 * Fold everything older than the kept window into the running summary.
		 * `force` skips the budget check (the /compact command); `focus` steers
		 * what the summary keeps. Reads the tail through `source` — the hook's or
		 * the last context:build's view for the hooks, the command's own reader for
		 * /compact. Returns what was folded, or null when nothing is due or nothing
		 * has aged out of the kept window yet. Throws when the model call fails or
		 * returns no text, so a caller can report it honestly.
		 */
		const fold = async (
			source: { reader?: TranscriptReader; messages?: Message[] },
			opts: { force?: boolean; focus?: string } = {},
		): Promise<{ folded: number; kept: number; uptoSeq: number } | null> => {
			const state = (await ctx.store.get<RollingState>(STATE_KEY)) ?? { summary: "" };
			const upto = summarizedUpto(state);

			// Only the not-yet-summarized tail counts toward the window budget.
			const tail = await readTail(source, upto);
			let trigger = "on demand";
			if (!opts.force) {
				const window = measureWindow(tail, await ctx.store.get<LastCall>(LAST_CALL_KEY));
				if (window.tokens < threshold) return null;
				trigger = `window ~${window.tokens} tokens (${window.reported ? "reported" : "estimated"}) reached ${Math.floor(threshold)}`;
			}

			const folded = cutPoint(
				tail.map((entry) => entry.message),
				keepTokens,
			);
			if (folded <= 0) return null; // nothing has aged out of the kept window yet
			const toFold = tail.slice(0, folded);
			const targetSeq = toFold[toFold.length - 1].seq;

			const conversation = toFold.map((entry) => renderMessage(entry.message)).join("\n");
			const prior = state.summary ? `Existing summary so far:\n${state.summary}\n\n` : "";
			const focus = opts.focus
				? `Pay particular attention to preserving anything related to: ${opts.focus}\n`
				: "";

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
									`${focus}Output only the updated summary.`,
								visibility: "chat",
							},
						],
					},
				],
				maxTokens: summaryMaxTokens,
			})) {
				if (chunk.type === "text_delta" && chunk.text) next += chunk.text;
			}

			next = next.trim();
			// Keep the prior summary rather than wipe it.
			if (!next) throw new Error("the summary model returned no text");

			// The last call measured the window before this fold; the next call
			// measures the folded one.
			await ctx.store.delete(LAST_CALL_KEY);
			await ctx.store.set<RollingState>(STATE_KEY, {
				summary: next,
				summarizedUptoSeq: targetSeq,
			});
			const kept = tail.length - folded;
			ctx.log.info(
				`Compacted ${folded} message(s) up to seq ${targetSeq} (${trigger}); ${kept} recent message(s) stay verbatim`,
			);
			return { folded, kept, uptoSeq: targetSeq };
		};

		/**
		 * The automatic fold at a step or turn boundary. Never throws: a failure is
		 * logged with its real cause, and automatic folds skip the rest of that
		 * turn (each attempt is a billed model call) and try again next turn.
		 * Without a turn id (older hosts) there is nothing to key the pause on.
		 */
		const autoFold = async (hookCtx: { transcript?: TranscriptReader; turn?: HookTurnInfo }) => {
			const turnId = hookCtx.turn?.turnId;
			try {
				const state = await ctx.store.get<RollingState>(STATE_KEY);
				if (turnId !== undefined && state?.failedTurnId === turnId) return;
				await fold({ reader: hookCtx.transcript ?? lastReader, messages: lastMessages });
			} catch (error) {
				ctx.log.warn(
					`Memory compaction failed: ${errorText(error)}${turnId !== undefined ? " — retrying next turn" : ""}`,
				);
				if (turnId === undefined) return;
				try {
					const state = (await ctx.store.get<RollingState>(STATE_KEY)) ?? { summary: "" };
					await ctx.store.set<RollingState>(STATE_KEY, { ...state, failedTurnId: turnId });
				} catch {
					// The warning above already reports the failure.
				}
			}
		};

		// Step boundaries too: a long agentic turn must not blow the window
		// between turn ends. Cheap when under threshold (no model call).
		ctx.hook(LifecycleEvent.StepEnd, autoFold);
		ctx.hook(LifecycleEvent.TurnEnd, autoFold);

		// `/compact [focus]`: fold now, whatever the budget says or an earlier
		// automatic failure. Runs outside a turn, so the history comes from the
		// command's own transcript reader, not from a context:build this runtime
		// may never have seen. Optional on hosts that predate slash commands.
		ctx.command?.(
			{
				name: "compact",
				description: "Fold older history into the running summary now",
				args: { description: "focus" },
			},
			async (args, commandCtx) => {
				if (!commandCtx.transcript) {
					throw new Error("/compact needs the transcript reader, which this host does not serve");
				}
				const focus = args.trim();
				const outcome = await fold(
					{ reader: commandCtx.transcript },
					{ force: true, ...(focus ? { focus } : {}) },
				);
				return {
					reply: outcome
						? `Compacted ${outcome.folded} message(s) into the summary; the last ${outcome.kept} stay verbatim.`
						: `Nothing to compact: the conversation since the last summary fits in the recent window (~${Math.floor(keepTokens)} tokens).`,
				};
			},
		);
	},
});
