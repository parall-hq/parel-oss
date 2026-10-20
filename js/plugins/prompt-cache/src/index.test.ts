import type {
	HookOptions,
	LifecycleEventType,
	Message,
	ModelCallParams,
	PluginContext,
} from "@parel/plugin-sdk";
import { HookPriority, LifecycleEvent } from "@parel/plugin-sdk";
import { describe, expect, test } from "vitest";
import plugin from "./index.js";

type Hook = (ctx: {
	modelParams: ModelCallParams;
	session?: { id: string };
}) => Promise<{ action: string; mutations?: { modelParams?: ModelCallParams } } | undefined>;

async function setup() {
	const hooks: { event: LifecycleEventType; handler: Hook; options?: HookOptions }[] = [];
	const ctx = {
		config: {},
		hook: (event: LifecycleEventType, handler: Hook, options?: HookOptions) => {
			hooks.push({ event, handler, options });
		},
	} as unknown as PluginContext;
	await plugin.setup(ctx);
	return hooks;
}

async function run(modelParams: ModelCallParams, session: { id: string } | null = { id: "ssn_1" }) {
	const [hook] = await setup();
	const result = await hook.handler({ modelParams, ...(session ? { session } : {}) });
	return result?.mutations?.modelParams;
}

const message = (role: Message["role"], id?: string, extra: Partial<Message> = {}): Message => ({
	role,
	...(id ? { id } : {}),
	parts: [{ type: "text", text: `${role} ${id ?? ""}` }],
	...extra,
});

const conversation = (): Message[] => [
	message("system", "sys"),
	message("user", "m1"),
	message("assistant", "m2"),
	message("tool", "m3"),
];

const TAIL = { eligible: true, priority: 70 };

describe("prompt-cache", () => {
	test("registers one late model:before hook", async () => {
		const hooks = await setup();
		expect(hooks).toHaveLength(1);
		expect(hooks[0].event).toBe(LifecycleEvent.ModelBefore);
		expect(hooks[0].options?.priority).toBe(HookPriority.Late);
	});

	test("hints the last message and sets a session cache key", async () => {
		const tools = [{ name: "read", description: "Read", parameters: { type: "object" } }];
		const params: ModelCallParams = {
			messages: conversation(),
			tools,
			providerOptions: { openai: { store: false }, anthropic: { top_k: 5 } },
		};
		const before = JSON.parse(JSON.stringify(params));

		const next = await run(params);

		expect(next?.messages.map((m) => m.cacheHint)).toEqual([undefined, undefined, undefined, TAIL]);
		expect(next?.tools).toBe(tools);
		expect(next?.providerOptions).toEqual({
			openai: { store: false, prompt_cache_key: "parel:ssn_1" },
			anthropic: { top_k: 5 },
		});
		expect(params).toEqual(before);
	});

	test("skips id-less and system messages when picking the tail", async () => {
		const next = await run({
			messages: [message("system", "sys"), message("user", "m1"), message("user")],
		});
		expect(next?.messages[1].cacheHint).toEqual(TAIL);
		expect(next?.messages[2].cacheHint).toBeUndefined();

		const systemOnly = await run({ messages: [message("system", "sys"), message("user")] });
		expect(systemOnly?.messages.every((m) => m.cacheHint === undefined)).toBe(true);
	});

	test("keeps the tail's own hint fields", async () => {
		const messages = conversation();
		messages[3] = message("tool", "m3", { cacheHint: { priority: 90, estimatedTokens: 1200 } });

		const next = await run({ messages });

		expect(next?.messages[3].cacheHint).toEqual({
			eligible: true,
			priority: 90,
			estimatedTokens: 1200,
		});
	});

	test("a tail marked not eligible gets no hint, and no earlier message does", async () => {
		const messages = conversation();
		messages[3] = message("tool", "m3", { cacheHint: { eligible: false } });

		const next = await run({ messages });

		expect(next?.messages).toBe(messages);
		expect(next?.providerOptions?.openai?.prompt_cache_key).toBe("parel:ssn_1");
	});

	test("an authored breakpoint plan stops the tail hint only", async () => {
		const messages = conversation();
		const promptCache: ModelCallParams["promptCache"] = {
			breakpoints: [{ target: "system", cacheControl: { type: "ephemeral" } }],
		};

		const next = await run({ messages, promptCache });

		expect(next?.messages).toBe(messages);
		expect(next?.promptCache).toBe(promptCache);
		expect(next?.providerOptions?.openai?.prompt_cache_key).toBe("parel:ssn_1");

		const empty = await run({ messages, promptCache: { breakpoints: [] } });
		expect(empty?.messages[3].cacheHint).toEqual(TAIL);
	});

	test.each([
		{ enabled: false },
		{ mode: "off" as const },
	])("turns off with promptCache %o", async (promptCache) => {
		expect(await run({ messages: conversation(), promptCache })).toBeUndefined();
	});

	test.each(["custom", null, ""])("keeps an authored prompt_cache_key (%o)", async (key) => {
		const next = await run({
			messages: conversation(),
			providerOptions: { openai: { prompt_cache_key: key } },
		});
		expect(next?.providerOptions?.openai?.prompt_cache_key).toBe(key);
		expect(next?.messages[3].cacheHint).toEqual(TAIL);
	});

	test("without a session id, only the tail is hinted", async () => {
		const next = await run({ messages: conversation() }, null);
		expect(next?.providerOptions).toBeUndefined();
		expect(next?.messages[3].cacheHint).toEqual(TAIL);
	});

	test("changes nothing when there is nothing to add", async () => {
		const params: ModelCallParams = {
			messages: [message("system", "sys"), message("user")],
			providerOptions: { openai: { prompt_cache_key: "custom" } },
		};
		expect(await run(params)).toBeUndefined();
		expect(await run({ messages: undefined as unknown as Message[] }, null)).toBeUndefined();
	});
});
