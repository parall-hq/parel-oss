import {
	definePlugin,
	type InputQueue,
	type InputQueueItem,
	LifecycleEvent,
	type Message,
	type ToolHandlerContext,
	type ToolOutput,
} from "@parel/plugin-sdk";

const CALLBACK_KIND = "approval_result";
const STORE_PREFIX = "approval:";

export type ApprovalStatus = "pending" | "approved" | "rejected";
export type ApprovalRisk = "low" | "medium" | "high" | "destructive";

export interface ApprovalRequestRecord {
	approvalId: string;
	status: ApprovalStatus;
	action: string;
	reason?: string;
	risk: ApprovalRisk;
	details?: string;
	requestedAt: string;
	requestedByToolCallId?: string;
	resolvedAt?: string;
	resolvedBy?: string;
	comment?: string;
}

interface RequestApprovalParams {
	action?: unknown;
	reason?: unknown;
	risk?: unknown;
	details?: unknown;
}

interface CheckApprovalParams {
	approvalId?: unknown;
}

interface ApprovalResultPayload {
	callbackKind: typeof CALLBACK_KIND;
	approvalId: string;
	status: "approved" | "rejected";
	comment?: string;
	resolvedBy?: string;
}

function hashKey(input: string): string {
	let hash = 5381;
	for (let i = 0; i < input.length; i++) {
		hash = ((hash << 5) + hash + input.charCodeAt(i)) | 0;
	}
	return (hash >>> 0).toString(36);
}

function safeSegment(value: string): string {
	const normalized = value.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
	return normalized.length > 0 ? normalized.slice(0, 96) : "request";
}

function storeKey(approvalId: string): string {
	return `${STORE_PREFIX}${approvalId}`;
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function requiredString(value: unknown, name: string): string {
	const result = optionalString(value);
	if (!result) throw new Error(`${name} must be a non-empty string`);
	return result;
}

function approvalRisk(value: unknown): ApprovalRisk {
	return value === "low" || value === "medium" || value === "high" || value === "destructive"
		? value
		: "medium";
}

function approvalIdFor(params: { action: string; reason?: string }, toolCtx: ToolHandlerContext) {
	const toolCallId = toolCtx.invocation?.toolCallId;
	if (toolCallId) return `approval_${safeSegment(toolCallId)}`;
	return `approval_${hashKey(`${params.action}\n${params.reason ?? ""}`)}`;
}

function renderRecord(record: ApprovalRequestRecord): string {
	const lines = [
		`approvalId: ${record.approvalId}`,
		`status: ${record.status}`,
		`risk: ${record.risk}`,
		`action: ${record.action}`,
	];
	if (record.reason) lines.push(`reason: ${record.reason}`);
	if (record.details) lines.push(`details: ${record.details}`);
	if (record.comment) lines.push(`comment: ${record.comment}`);
	return lines.join("\n");
}

function parseApprovalResult(payload: unknown): ApprovalResultPayload | null {
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
	const record = payload as Record<string, unknown>;
	if (record.callbackKind !== CALLBACK_KIND) return null;
	const approvalId = optionalString(record.approvalId);
	if (!approvalId) return null;
	const status =
		record.status === "approved" || record.status === "rejected" ? record.status : undefined;
	if (!status) return null;
	return {
		callbackKind: CALLBACK_KIND,
		approvalId,
		status,
		...(optionalString(record.comment) ? { comment: optionalString(record.comment) } : {}),
		...(optionalString(record.resolvedBy) ? { resolvedBy: optionalString(record.resolvedBy) } : {}),
	};
}

function isApprovalResultCallback(item: InputQueueItem): boolean {
	return parseApprovalResult(item.payload) !== null;
}

function drainApprovalResultInputs(inputs: InputQueue): InputQueueItem[] {
	if (inputs.drainWhere) return inputs.drainWhere("async_callback", isApprovalResultCallback);

	const asyncCallbacks = inputs.drain("async_callback");
	const approvalCallbacks: InputQueueItem[] = [];

	for (const item of asyncCallbacks) {
		if (isApprovalResultCallback(item)) {
			approvalCallbacks.push(item);
			continue;
		}
		inputs.push({ type: item.type, payload: item.payload, source: item.source });
	}

	return approvalCallbacks;
}

function approvalMessage(payload: ApprovalResultPayload): Message {
	const comment = payload.comment ? `\n${payload.comment}` : "";
	return {
		role: "user",
		parts: [
			{
				type: "text",
				text: `<approval_result id="${payload.approvalId}" status="${payload.status}">${comment}\n</approval_result>`,
				visibility: "chat",
			},
		],
	};
}

export default definePlugin({
	name: "@parel/approval-tools",
	version: "0.1.0",
	provides: { hooks: true, tools: true },
	requires: { permissions: { inputs: true, store: true } },

	async setup(ctx) {
		ctx.tool(
			{
				name: "request_approval",
				description:
					"Request user approval before taking a risky or user-visible action. The request is pending until an approval_result async callback arrives.",
				parameters: {
					type: "object",
					properties: {
						action: {
							type: "string",
							description: "Concrete action that needs approval.",
						},
						reason: {
							type: "string",
							description: "Why approval is needed.",
						},
						risk: {
							type: "string",
							enum: ["low", "medium", "high", "destructive"],
							description: "Risk level for the requested action.",
						},
						details: {
							type: "string",
							description: "Optional command, file path, or extra context.",
						},
					},
					required: ["action"],
				},
				scheduling: { defaultMode: "exclusive" },
			},
			async (params: RequestApprovalParams, toolCtx): Promise<ToolOutput> => {
				const action = requiredString(params.action, "action");
				const reason = optionalString(params.reason);
				const risk = approvalRisk(params.risk);
				const details = optionalString(params.details);
				const approvalId = approvalIdFor({ action, reason }, toolCtx);
				const existing = await toolCtx.store.get<ApprovalRequestRecord>(storeKey(approvalId));
				const record: ApprovalRequestRecord = existing ?? {
					approvalId,
					status: "pending",
					action,
					risk,
					requestedAt: new Date().toISOString(),
					...(reason ? { reason } : {}),
					...(details ? { details } : {}),
					...(toolCtx.invocation?.toolCallId
						? { requestedByToolCallId: toolCtx.invocation.toolCallId }
						: {}),
				};
				await toolCtx.store.set(storeKey(approvalId), record);
				ctx.interrupt();
				return {
					content: [
						"Approval requested.",
						renderRecord(record),
						`callbackKind: ${CALLBACK_KIND}`,
					].join("\n"),
				};
			},
		);

		ctx.tool(
			{
				name: "check_approval",
				description: "Check a pending approval request by approvalId.",
				parameters: {
					type: "object",
					properties: {
						approvalId: {
							type: "string",
							description: "Approval id returned by request_approval.",
						},
					},
					required: ["approvalId"],
				},
				scheduling: { defaultMode: "parallel" },
			},
			async (params: CheckApprovalParams, toolCtx): Promise<string> => {
				const approvalId = requiredString(params.approvalId, "approvalId");
				const record = await toolCtx.store.get<ApprovalRequestRecord>(storeKey(approvalId));
				return record ? renderRecord(record) : `No approval request found: ${approvalId}`;
			},
			{ scheduling: { defaultMode: "parallel" }, isConcurrencySafe: () => true },
		);

		ctx.hook(LifecycleEvent.ContextBuild, async (hookCtx) => {
			const callbacks = drainApprovalResultInputs(hookCtx.inputs);
			if (callbacks.length === 0) return;

			const messages: Message[] = [];
			for (const item of callbacks) {
				const payload = parseApprovalResult(item.payload);
				if (!payload) continue;
				const existing = await hookCtx.store.get<ApprovalRequestRecord>(
					storeKey(payload.approvalId),
				);
				const record: ApprovalRequestRecord = {
					approvalId: payload.approvalId,
					status: payload.status,
					action: existing?.action ?? "(external approval)",
					risk: existing?.risk ?? "medium",
					requestedAt: existing?.requestedAt ?? new Date(item.timestamp).toISOString(),
					...(existing?.reason ? { reason: existing.reason } : {}),
					...(existing?.details ? { details: existing.details } : {}),
					...(existing?.requestedByToolCallId
						? { requestedByToolCallId: existing.requestedByToolCallId }
						: {}),
					resolvedAt: new Date(item.timestamp).toISOString(),
					...(payload.resolvedBy ? { resolvedBy: payload.resolvedBy } : {}),
					...(payload.comment ? { comment: payload.comment } : {}),
				};
				await hookCtx.store.set(storeKey(payload.approvalId), record);
				messages.push(approvalMessage(payload));
			}

			if (messages.length === 0) return;
			return {
				action: "continue" as const,
				mutations: { messages: [...hookCtx.messages, ...messages] },
			};
		});
	},
});
