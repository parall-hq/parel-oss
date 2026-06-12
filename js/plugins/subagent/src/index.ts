import {
	definePlugin,
	type InputQueue,
	type InputQueueItem,
	LifecycleEvent,
	type Message,
	type ModelGatewayAccess,
	PAREL_RUNTIME_CAPABILITY,
	type ParelPlugin,
	type RuntimeControl,
} from "@parel/plugin-sdk";
import manifest from "../parel.plugin.json" with { type: "json" };

// @parel/subagent — delegate work to subagents.
//
// Two modes, selected per call (or by config default):
//  - "sync"  : run an inline model call now and return its text as the tool
//              result. Needs no runtime support; works anywhere ctx.model does.
//  - "async" : spawn a background child session via the host-provided
//              parel.runtime capability and return immediately. The child's
//              result is later delivered back as an `async_callback` input with
//              payload.callbackKind="subagent_result", which this plugin renders
//              as a <subagent_notification> in a new turn.
//
// If "async" is requested but the runtime does not provide parel.runtime, we
// fall back to "sync" (cf. Mastra's `fallback-sync`). Design:
// docs/async-subagent.md (runtime repo).

interface SubagentConfig {
	/** Default mode when a call does not specify one. Default: "sync". */
	mode?: "sync" | "async";
	/** Default child agent for async spawns when a call omits `agent`. */
	agent?: string;
	/** Default system instructions for the inline (sync) subagent. */
	instructions?: string;
	/** Max output tokens for the inline (sync) subagent. */
	maxTokens?: number;
}

interface SubagentToolParams {
	task?: unknown;
	instructions?: unknown;
	agent?: unknown;
	mode?: unknown;
	context?: unknown;
}

const TOOL_NAME = "subagent";
const ASYNC_CALLBACK_TYPE = "async_callback";
const SUBAGENT_CALLBACK_KIND = "subagent_result";

/** Deterministic string hash (djb2) — no Date/Math.random, safe for idempotency keys. */
function hashKey(input: string): string {
	let hash = 5381;
	for (let i = 0; i < input.length; i++) {
		hash = ((hash << 5) + hash + input.charCodeAt(i)) | 0;
	}
	return (hash >>> 0).toString(36);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isSubagentCallback(item: InputQueueItem): boolean {
	return isRecord(item.payload) && item.payload.callbackKind === SUBAGENT_CALLBACK_KIND;
}

function drainSubagentResultInputs(inputs: InputQueue): InputQueueItem[] {
	if (inputs.drainWhere) {
		return [
			...inputs.drainWhere(ASYNC_CALLBACK_TYPE, isSubagentCallback),
			...inputs.drain(SUBAGENT_CALLBACK_KIND),
		];
	}

	const asyncCallbacks = inputs.drain(ASYNC_CALLBACK_TYPE);
	const subagentCallbacks: InputQueueItem[] = [];

	for (const item of asyncCallbacks) {
		if (isSubagentCallback(item)) {
			subagentCallbacks.push(item);
			continue;
		}
		// InputQueue drains by type, while async_callback is platform-generic.
		// Preserve callbacks meant for other plugins until the SDK grows predicate drain.
		inputs.push({ type: item.type, payload: item.payload, source: item.source });
	}

	return [...subagentCallbacks, ...inputs.drain(SUBAGENT_CALLBACK_KIND)];
}

async function runInline(
	model: ModelGatewayAccess,
	opts: { task: string; instructions?: string; maxTokens?: number },
): Promise<string> {
	const messages: Message[] = [];
	if (opts.instructions) {
		messages.push({ role: "system", parts: [{ type: "text", text: opts.instructions }] });
	}
	messages.push({ role: "user", parts: [{ type: "text", text: opts.task }] });

	let text = "";
	for await (const chunk of model.chat({
		messages,
		...(opts.maxTokens ? { maxTokens: opts.maxTokens } : {}),
	})) {
		if (chunk.type === "text_delta") text += chunk.text;
	}
	return text.trim() || "(subagent produced no output)";
}

export default definePlugin({
	name: "@parel/subagent",
	provides: { tools: true, hooks: true },
	requires: { permissions: { model: true, inputs: true } },
	execution: manifest.execution as ParelPlugin["execution"],

	async setup(ctx) {
		const config = (ctx.config ?? {}) as SubagentConfig;
		const defaultMode = config.mode ?? "sync";

		// parel.runtime is optional: when absent, async degrades to sync.
		let runtime: RuntimeControl | undefined;
		try {
			runtime = ctx.require<RuntimeControl>(PAREL_RUNTIME_CAPABILITY);
		} catch {
			runtime = undefined;
		}

		ctx.tool(
			{
				name: TOOL_NAME,
				description:
					"Delegate a self-contained task to a subagent. mode=sync returns the result inline now; mode=async spawns a background subagent and notifies you when it finishes.",
				parameters: {
					type: "object",
					properties: {
						task: { type: "string", description: "The self-contained task to delegate." },
						instructions: {
							type: "string",
							description: "Optional system instructions / role for the subagent.",
						},
						agent: {
							type: "string",
							description: "async only: which agent the child session runs.",
						},
						mode: {
							type: "string",
							enum: ["sync", "async"],
							description: "sync = inline result now; async = background, notified later.",
						},
						context: {
							type: "string",
							enum: ["fresh", "fork"],
							description:
								"async only: start the child from a fresh context or a fork of this one.",
						},
					},
					required: ["task"],
				},
			},
			async (params: SubagentToolParams, toolCtx) => {
				const task = typeof params.task === "string" ? params.task.trim() : "";
				if (!task) return "Error: 'task' is required.";

				const instructions =
					typeof params.instructions === "string" ? params.instructions : config.instructions;
				const mode = params.mode === "async" || params.mode === "sync" ? params.mode : defaultMode;

				if (mode === "async" && runtime) {
					const context = params.context === "fork" ? "fork" : "fresh";
					const agent = typeof params.agent === "string" ? params.agent : config.agent;
					if (context === "fresh" && !agent) {
						return "Error: async fresh mode needs an 'agent' (pass `agent` or set config.agent).";
					}
					// Plugin-side portion of the idempotency key; the host augments it
					// with the parent session/turn/step/tool identity so a workflow-step
					// retry is a no-op without colliding with another tool call.
					const idempotencyKey = hashKey(`${agent ?? "parent"}\n${task}\n${instructions ?? ""}`);
					const origin = toolCtx.invocation
						? {
								parentTurnId: toolCtx.invocation.turnId,
								parentStepId: String(toolCtx.invocation.stepNumber),
								parentToolCallId: toolCtx.invocation.toolCallId,
								originPlugin: toolCtx.invocation.pluginName,
							}
						: undefined;
					try {
						const handle = await runtime.startChildSession({
							input: task,
							mode: "async",
							context,
							...(agent ? { agent } : {}),
							idempotencyKey,
							...(origin ? { origin } : {}),
							...(instructions ? { metadata: { instructions } } : {}),
						});
						return `Spawned subagent (invocation ${handle.childInvocationId}, session ${handle.childSessionId}). It runs in the background; you'll get a <subagent_notification> when it finishes.`;
					} catch (err) {
						const msg = err instanceof Error ? err.message : String(err);
						return `Failed to spawn subagent: ${msg}`;
					}
				}

				// sync inline (also the fallback when async has no runtime support).
				return runInline(ctx.model, {
					task,
					...(instructions ? { instructions } : {}),
					...(config.maxTokens ? { maxTokens: config.maxTokens } : {}),
				});
			},
		);

		// --- Control tools for async children (require parel.runtime) ---
		// All operate on the childInvocationId returned by an async spawn. With no
		// runtime they report that clearly rather than silently no-op.
		const withRuntime = (): RuntimeControl | string =>
			runtime ??
			"Error: subagent control requires the parel.runtime capability, which this host does not provide.";

		ctx.tool(
			{
				name: "subagent_status",
				description:
					"Check the status of an async subagent by its invocation id (from the spawn ack).",
				parameters: {
					type: "object",
					properties: {
						invocation_id: {
							type: "string",
							description: "childInvocationId returned when the subagent was spawned.",
						},
					},
					required: ["invocation_id"],
				},
			},
			async (params: { invocation_id?: unknown }) => {
				const rt = withRuntime();
				if (typeof rt === "string") return rt;
				const id = typeof params.invocation_id === "string" ? params.invocation_id.trim() : "";
				if (!id) return "Error: 'invocation_id' is required.";
				try {
					const child = await rt.getChild(id);
					const fields = [`status=${child.status}`];
					if (child.childSessionId) fields.push(`session=${child.childSessionId}`);
					if (child.resultRef) fields.push(`result=${child.resultRef}`);
					if (child.error) {
						fields.push(
							`error=${child.error instanceof Error ? child.error.message : String(child.error)}`,
						);
					}
					return fields.join(" ");
				} catch (err) {
					return `Failed to get subagent status: ${err instanceof Error ? err.message : String(err)}`;
				}
			},
		);

		ctx.tool(
			{
				name: "subagent_cancel",
				description: "Cancel a running async subagent (and its descendants) by invocation id.",
				parameters: {
					type: "object",
					properties: {
						invocation_id: { type: "string", description: "childInvocationId to cancel." },
					},
					required: ["invocation_id"],
				},
			},
			async (params: { invocation_id?: unknown }) => {
				const rt = withRuntime();
				if (typeof rt === "string") return rt;
				const id = typeof params.invocation_id === "string" ? params.invocation_id.trim() : "";
				if (!id) return "Error: 'invocation_id' is required.";
				try {
					await rt.cancelChild(id);
					return `Cancelled subagent ${id}.`;
				} catch (err) {
					return `Failed to cancel subagent: ${err instanceof Error ? err.message : String(err)}`;
				}
			},
		);

		ctx.tool(
			{
				name: "subagent_signal",
				description: "Send a follow-up message to a running async subagent to redirect it.",
				parameters: {
					type: "object",
					properties: {
						invocation_id: { type: "string", description: "childInvocationId to signal." },
						message: { type: "string", description: "The follow-up message for the subagent." },
					},
					required: ["invocation_id", "message"],
				},
			},
			async (params: { invocation_id?: unknown; message?: unknown }) => {
				const rt = withRuntime();
				if (typeof rt === "string") return rt;
				const id = typeof params.invocation_id === "string" ? params.invocation_id.trim() : "";
				const message = typeof params.message === "string" ? params.message.trim() : "";
				if (!id) return "Error: 'invocation_id' is required.";
				if (!message) return "Error: 'message' is required.";
				try {
					await rt.signalChild(id, message);
					return `Signalled subagent ${id}.`;
				} catch (err) {
					return `Failed to signal subagent: ${err instanceof Error ? err.message : String(err)}`;
				}
			},
		);

		// Async re-entry: when a child session completes, the host delivers its
		// result as a platform-level async_callback input and starts a new turn.
		// Render subagent callbacks as context for the model (cf. steering-immediate).
		ctx.hook(LifecycleEvent.ContextBuild, async (hookCtx) => {
			const results = drainSubagentResultInputs(hookCtx.inputs);
			if (results.length === 0) return;

			const notifications = results.map((item) => {
				const p = (item.payload ?? {}) as {
					childSessionId?: string;
					status?: string;
					summary?: string;
				};
				const status = p.status ?? "completed";
				const session = p.childSessionId ?? "";
				return {
					role: "user" as const,
					parts: [
						{
							type: "text" as const,
							text: `<subagent_notification session="${session}" status="${status}">\n${p.summary ?? ""}\n</subagent_notification>`,
							visibility: "chat" as const,
						},
					],
				};
			});

			return {
				action: "continue" as const,
				mutations: { messages: [...hookCtx.messages, ...notifications] },
			};
		});
	},
});
