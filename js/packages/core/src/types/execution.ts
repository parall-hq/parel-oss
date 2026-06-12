import type { InputQueueItem, Message, SessionState } from "./session.js";

/** Capability name under which the host registers {@link ExecutionControl}. */
export const PAREL_EXECUTION_CONTROL_CAPABILITY = "parel.execution";

export type ExecutionAnchor =
	| "turn_start"
	| "step_start"
	| "before_model"
	| "after_model"
	| "before_tool"
	| "after_tool"
	| "turn_end"
	| "manual";

export type ExecutionUseCase =
	| "debugger"
	| "playground"
	| "human_in_loop"
	| "eval"
	| "incident"
	| "workflow"
	| "plugin";

export interface ExecutionSnapshotPolicy {
	store?: "copy" | "redact" | "reset";
	providerArtifacts?: "required_only" | "all_replayable" | "none";
	inputs?: "copy" | "drop";
}

export interface ExecutionSnapshotPointers {
	checkpointId?: string;
	messageSeqEnd?: number;
	turnId?: string;
	stepNumber?: number;
	eventSeq?: number;
	storeHash?: string;
	inputsHash?: string;
}

export interface ExecutionSnapshot {
	id: string;
	sessionId: string;
	agentId: string;
	orgId: string;
	turnId?: string;
	stepNumber?: number;
	anchor: ExecutionAnchor;
	label?: string;
	reason?: string;
	useCase?: ExecutionUseCase;
	state: SessionState;
	policy: ExecutionSnapshotPolicy;
	pointers: ExecutionSnapshotPointers;
	metadata?: Record<string, unknown>;
	createdAt: string;
}

export interface ExecutionPausePolicy {
	id: string;
	sessionId: string;
	anchor: ExecutionAnchor;
	enabled: boolean;
	oneShot?: boolean;
	condition?: {
		toolName?: string;
		stepNumber?: number;
		eventType?: string;
	};
	label?: string;
	reason?: string;
	useCase?: ExecutionUseCase;
	metadata?: Record<string, unknown>;
	createdAt: string;
}

export type ExecutionPauseStatus = "paused" | "resumed" | "cancelled";

export interface ExecutionPause {
	id: string;
	sessionId: string;
	policyId?: string;
	snapshotId: string;
	status: ExecutionPauseStatus;
	anchor: ExecutionAnchor;
	payload?: Record<string, unknown>;
	resumePayload?: Record<string, unknown>;
	createdAt: string;
	resumedAt?: string;
	cancelledAt?: string;
}

export type ExecutionPauseCheckAnchor =
	| "step_start"
	| "before_model"
	| "after_model"
	| "before_tool"
	| "after_tool";

export interface ExecutionPauseCheckOptions {
	anchor: ExecutionPauseCheckAnchor;
	payload?: Record<string, unknown>;
	pendingMessages?: Message[];
	pendingState?: SessionState;
}

export interface ExecutionPauseCheckResult {
	paused: boolean;
	reason?: string;
	pause?: ExecutionPause;
}

export type SetExecutionPausePolicyOptions = Omit<
	ExecutionPausePolicy,
	"id" | "sessionId" | "createdAt"
>;

export interface ExecutionBranchMutations {
	inputOverride?: string;
	modelOverride?: string;
	runtimeConfigOverride?: Record<string, unknown>;
	storePatch?: Record<string, unknown>;
	metadata?: Record<string, unknown>;
}

export type ExecutionBranchStatus = "provisioning" | "ready" | "running" | "failed";

export interface ExecutionBranch {
	id: string;
	sourceSnapshotId: string;
	sourceSessionId: string;
	branchSessionId?: string;
	mode: "branch" | "replay";
	status: ExecutionBranchStatus;
	useCase?: ExecutionUseCase;
	mutations?: ExecutionBranchMutations;
	error?: string;
	createdAt: string;
	updatedAt?: string;
}

export interface CaptureExecutionSnapshotOptions {
	anchor: ExecutionAnchor;
	label?: string;
	reason?: string;
	useCase?: ExecutionUseCase;
	policy?: Partial<ExecutionSnapshotPolicy>;
	metadata?: Record<string, unknown>;
	idempotencyKey?: string;
}

export interface ListExecutionSnapshotsOptions {
	limit?: number;
	anchor?: ExecutionAnchor;
	useCase?: ExecutionUseCase;
}

export interface BranchFromExecutionSnapshotOptions {
	useCase?: ExecutionUseCase;
	mutations?: ExecutionBranchMutations;
	input?: string;
	run?: boolean;
	idempotencyKey?: string;
}

export interface ReplayFromExecutionSnapshotOptions {
	useCase?: ExecutionUseCase;
	input?: string;
	run?: boolean;
	idempotencyKey?: string;
}

export interface ExecutionControl {
	captureSnapshot(opts: CaptureExecutionSnapshotOptions): Promise<ExecutionSnapshot>;
	getSnapshot(snapshotId: string): Promise<ExecutionSnapshot>;
	listSnapshots(opts?: ListExecutionSnapshotsOptions): Promise<ExecutionSnapshot[]>;
	setPausePolicy(policy: SetExecutionPausePolicyOptions): Promise<ExecutionPausePolicy>;
	clearPausePolicy(policyId: string): Promise<void>;
	checkPause(opts: ExecutionPauseCheckOptions): Promise<ExecutionPauseCheckResult>;
	resumePause(pauseId: string, payload?: Record<string, unknown>): Promise<void>;
	cancelPause(pauseId: string): Promise<void>;
	branchFromSnapshot(
		snapshotId: string,
		opts?: BranchFromExecutionSnapshotOptions,
	): Promise<ExecutionBranch>;
	replayFromSnapshot(
		snapshotId: string,
		opts?: ReplayFromExecutionSnapshotOptions,
	): Promise<ExecutionBranch>;
}

export interface ExecutionSnapshotMaterial {
	state: SessionState;
	storeData: Record<string, unknown>;
	inputs: InputQueueItem[];
	messages?: unknown[];
	providerArtifacts?: unknown[];
}
