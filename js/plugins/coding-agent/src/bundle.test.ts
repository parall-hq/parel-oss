import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import approvalToolsPlugin from "@parel/approval-tools";
import editToolsPlugin from "@parel/edit-tools";
import filesystemToolsPlugin from "@parel/filesystem-tools";
import gitToolsPlugin from "@parel/git-tools";
import {
	type HookHandler,
	type InputQueue,
	type InputQueueItem,
	LifecycleEvent,
	type ModelGatewayAccess,
	PAREL_RUNTIME_CAPABILITY,
	type ParelPlugin,
	type PluginContext,
	type RuntimeControl,
	type SessionStore,
	type ToolDefinition,
	type ToolHandler,
	type ToolRegistrationOptions,
} from "@parel/plugin-sdk";
import portToolsPlugin from "@parel/port-tools";
import processToolsPlugin from "@parel/process-tools";
import sandboxE2bPlugin from "@parel/sandbox-e2b";
import searchToolsPlugin from "@parel/search-tools";
import securityBasicPlugin from "@parel/security-basic";
import shellToolsPlugin from "@parel/shell-tools";
import subagentPlugin from "@parel/subagent";
import workspacePlugin from "@parel/workspace";
import { describe, expect, it, vi } from "vitest";
import codingAgentPlugin from "./index.js";

interface RegisteredTool {
	definition: ToolDefinition;
	handler: ToolHandler;
	options?: ToolRegistrationOptions;
	pluginName: string;
}

function makeStore(): SessionStore {
	const values = new Map<string, unknown>();
	return {
		async get<T = unknown>(key: string): Promise<T | null> {
			return (values.get(key) as T | undefined) ?? null;
		},
		async set<T = unknown>(key: string, value: T): Promise<void> {
			values.set(key, value);
		},
		async delete(key: string): Promise<void> {
			values.delete(key);
		},
		async list(prefix = ""): Promise<string[]> {
			return [...values.keys()].filter((key) => key.startsWith(prefix));
		},
	};
}

function makeInputs(): InputQueue {
	const items: InputQueueItem[] = [];
	return {
		drain(type: string) {
			const matched = items.filter((item) => item.type === type);
			for (const item of matched) items.splice(items.indexOf(item), 1);
			return matched;
		},
		drainWhere(type: string, predicate: (item: InputQueueItem) => boolean) {
			const matched: InputQueueItem[] = [];
			const remaining: InputQueueItem[] = [];
			for (const item of items) {
				if (item.type === type && predicate(item)) matched.push(item);
				else remaining.push(item);
			}
			items.splice(0, items.length, ...remaining);
			return matched;
		},
		peek(type: string) {
			return items.filter((item) => item.type === type);
		},
		push(item: Omit<InputQueueItem, "id" | "timestamp">) {
			items.push({ ...item, id: `input_${items.length + 1}`, timestamp: Date.now() });
		},
	};
}

function fakeModel(): ModelGatewayAccess {
	return {
		async *chat() {
			yield { type: "text_delta" as const, text: "ok" };
		},
		capabilities() {
			return {
				modelId: "fake",
				provider: "fake",
				maxContextTokens: 128000,
				toolCalling: true,
				parallelToolCalls: true,
				streaming: true,
				vision: false,
				thinking: false,
			};
		},
		listProviders() {
			return ["fake"];
		},
	};
}

function fakeRuntime(): RuntimeControl {
	return {
		startChildSession: vi.fn().mockResolvedValue({
			childInvocationId: "ci_1",
			childSessionId: "sess_child",
		}),
	};
}

function makeBundleHarness(configs: Record<string, Record<string, unknown>>) {
	const provided = new Map<string, unknown>([[PAREL_RUNTIME_CAPABILITY, fakeRuntime()]]);
	const tools = new Map<string, RegisteredTool>();
	const hooks = new Map<string, HookHandler<never>[]>();
	const store = makeStore();
	const inputs = makeInputs();

	function contextFor(pluginName: string): PluginContext {
		return {
			config: configs[pluginName] ?? {},
			store,
			inputs,
			model: fakeModel(),
			log: { debug() {}, info() {}, warn() {}, error() {} },
			require<T = unknown>(name: string): T {
				if (!provided.has(name)) throw new Error(`capability not provided: ${name}`);
				return provided.get(name) as T;
			},
			provide<T = unknown>(name: string, implementation: T): void {
				provided.set(name, implementation);
			},
			tool(definition: ToolDefinition, handler: ToolHandler, options?: ToolRegistrationOptions) {
				if (tools.has(definition.name)) throw new Error(`duplicate tool: ${definition.name}`);
				tools.set(definition.name, { definition, handler, options, pluginName });
			},
			hook(event: string, handler: HookHandler<never>) {
				hooks.set(event, [...(hooks.get(event) ?? []), handler]);
			},
			interrupt() {},
		} as unknown as PluginContext;
	}

	return { provided, tools, hooks, contextFor };
}

const bundlePlugins: ParelPlugin[] = [
	codingAgentPlugin,
	securityBasicPlugin,
	sandboxE2bPlugin,
	workspacePlugin,
	filesystemToolsPlugin,
	searchToolsPlugin,
	editToolsPlugin,
	gitToolsPlugin,
	shellToolsPlugin,
	processToolsPlugin,
	portToolsPlugin,
	approvalToolsPlugin,
	subagentPlugin,
];

function pluginNamesFromExample(): string[] {
	const example = readFileSync(
		resolve(process.cwd(), "../../../examples/coding-agent.yaml"),
		"utf8",
	);
	return [...example.matchAll(/^\s*-\s+plugin:\s+"([^"]+)"/gm)].map((match) => match[1] ?? "");
}

function schedulingMode(tool: RegisteredTool | undefined): string | undefined {
	return tool?.options?.scheduling?.defaultMode ?? tool?.definition.scheduling?.defaultMode;
}

describe("@parel/coding-agent bundle", () => {
	it("matches and loads the coding-agent example plugin bundle", async () => {
		expect(bundlePlugins.map((plugin) => plugin.name)).toEqual(pluginNamesFromExample());

		const configs = {
			"@parel/sandbox-e2b": { template: "base" },
			"@parel/workspace": {
				workspaceId: "ws_repo",
				identity: { sourceKind: "git", repo: "git@github.com:org/repo.git", branch: "main" },
				root: "/workspace/repo",
				baseDir: "/workspace",
			},
			"@parel/subagent": { mode: "async" },
		};
		const harness = makeBundleHarness(configs);

		for (const plugin of bundlePlugins) {
			await plugin.setup(harness.contextFor(plugin.name));
		}

		expect([...harness.provided.keys()]).toEqual(
			expect.arrayContaining([
				PAREL_RUNTIME_CAPABILITY,
				"filesystem",
				"exec",
				"process",
				"ports",
				"workspace",
			]),
		);
		expect([...harness.hooks.keys()]).toEqual(
			expect.arrayContaining([
				LifecycleEvent.ContextBuild,
				LifecycleEvent.ToolBefore,
				LifecycleEvent.ToolAfter,
				LifecycleEvent.SessionStart,
				LifecycleEvent.SessionResume,
				LifecycleEvent.SessionSuspend,
				LifecycleEvent.SessionEnd,
			]),
		);
		expect([...harness.tools.keys()]).toEqual(
			expect.arrayContaining([
				"workspace_current",
				"workspace_materialize",
				"workspace_export",
				"workspace_read_file",
				"workspace_list_dir",
				"workspace_write_file",
				"workspace_search_text",
				"workspace_find_files",
				"workspace_edit_file",
				"workspace_apply_patch",
				"workspace_git_status",
				"workspace_git_diff",
				"workspace_git_branches",
				"workspace_git_switch_branch",
				"workspace_git_commit",
				"workspace_shell",
				"workspace_start_process",
				"workspace_list_processes",
				"workspace_tail_process",
				"workspace_stop_process",
				"workspace_expose_port",
				"workspace_list_ports",
				"workspace_revoke_port",
				"request_approval",
				"check_approval",
				"subagent",
			]),
		);

		expect(schedulingMode(harness.tools.get("workspace_read_file"))).toBe("parallel");
		expect(schedulingMode(harness.tools.get("workspace_write_file"))).toBe("exclusive");
		expect(harness.tools.get("workspace_shell")?.pluginName).toBe("@parel/shell-tools");
	});
});
