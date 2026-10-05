import { describe, expect, test } from "vitest";
import {
	channelSecretRefs,
	gatherDeploySecrets,
	parseSecretOverrides,
	secretValuePrefix,
	unstoredSecretRefs,
} from "./deploy-secrets.js";

const agent = (
	plugins: Array<Record<string, unknown>>,
	modelConfig = {},
	channels: Array<Record<string, unknown>> = [],
) => ({
	modelConfig,
	plugins: plugins.map((config) => ({ config })),
	channels: channels.map((config) => ({ config })),
});

describe("parseSecretOverrides", () => {
	test("parses repeated NAME=value flags", () => {
		expect(parseSecretOverrides(["A_ONE=v1", "B_TWO=v=with=equals"])).toEqual({
			A_ONE: "v1",
			B_TWO: "v=with=equals",
		});
		expect(parseSecretOverrides("A_ONE=v1")).toEqual({ A_ONE: "v1" });
		expect(parseSecretOverrides(undefined)).toEqual({});
	});

	test("rejects malformed flags and bad names", () => {
		expect(() => parseSecretOverrides(["NOEQUALS"])).toThrow(/expected NAME=value/);
		expect(() => parseSecretOverrides(["=v"])).toThrow(/expected NAME=value/);
		expect(() => parseSecretOverrides(["lower_case=v"])).toThrow(/UPPER_SNAKE_CASE/);
	});
});

describe("gatherDeploySecrets", () => {
	test("collects referenced names from env, overrides win", () => {
		const result = gatherDeploySecrets(
			agent([{ apiKey: "${E2B_API_KEY}" }, { nested: { token: "${GH_TOKEN}" } }], {
				apiKey: "${MODEL_KEY}",
			}),
			{ GH_TOKEN: "from-flag" },
			{ E2B_API_KEY: "from-env", MODEL_KEY: "model-env", UNRELATED: "never-read" },
		);
		expect(result).toEqual([
			{ name: "E2B_API_KEY", value: "from-env", source: "local env" },
			{ name: "GH_TOKEN", value: "from-flag", source: "--secret" },
			{ name: "MODEL_KEY", value: "model-env", source: "local env" },
		]);
	});

	test("leaves unresolved names for the server (org/agent store)", () => {
		const result = gatherDeploySecrets(agent([{ apiKey: "${NOT_LOCAL}" }]), {}, {});
		expect(result).toEqual([]);
	});

	test("rejects overrides that match no reference", () => {
		expect(() =>
			gatherDeploySecrets(agent([{ apiKey: "${E2B_API_KEY}" }]), { TYPO_NAME: "v" }, {}),
		).toThrow(/does not match any \$\{TYPO_NAME\}/);
	});

	test("ignores literals and non-whole-value strings", () => {
		const result = gatherDeploySecrets(
			agent([{ apiKey: "sk-literal", url: "https://${HOST}/x" }]),
			{},
			{ HOST: "h" },
		);
		expect(result).toEqual([]);
	});
});

describe("channel secret references", () => {
	test("reads top-level channel config values only, as the server does", () => {
		const config = agent([], {}, [
			{ appToken: "${SLACK_APP_TOKEN}", nested: { token: "${NOT_READ}" } },
			{ webhookSecret: "${HOOK_SECRET}" },
		]);
		expect(channelSecretRefs(config)).toEqual(["HOOK_SECRET", "SLACK_APP_TOKEN"]);
	});

	test("deploy uploads channel references from env and accepts --secret for them", () => {
		const result = gatherDeploySecrets(
			agent([], {}, [{ appToken: "${SLACK_APP_TOKEN}", botToken: "${SLACK_BOT_TOKEN}" }]),
			{ SLACK_BOT_TOKEN: "from-flag" },
			{ SLACK_APP_TOKEN: "from-env" },
		);
		expect(result).toEqual([
			{ name: "SLACK_APP_TOKEN", value: "from-env", source: "local env" },
			{ name: "SLACK_BOT_TOKEN", value: "from-flag", source: "--secret" },
		]);
	});
});

describe("unstoredSecretRefs", () => {
	const config = agent([{ apiKey: "${E2B_API_KEY}" }], { apiKey: "${MODEL_KEY}" }, [
		{ appToken: "${SLACK_APP_TOKEN}" },
	]);

	test("model and plugin refs resolve from workspace or this agent's own values", () => {
		const missing = unstoredSecretRefs(
			config,
			[
				{ name: "MODEL_KEY", agent_id: "" },
				{ name: "E2B_API_KEY", agent_id: "agt_1", instance_id: "" },
				{ name: "SLACK_APP_TOKEN", agent_id: "" },
			],
			"agt_1",
		);
		expect(missing).toEqual({ agent: [], channel: [] });
	});

	test("another agent's or an instance's value does not count", () => {
		const missing = unstoredSecretRefs(
			config,
			[
				{ name: "MODEL_KEY", agent_id: "agt_other" },
				{ name: "E2B_API_KEY", agent_id: "agt_1", instance_id: "ins_1" },
			],
			"agt_1",
		);
		expect(missing).toEqual({ agent: ["E2B_API_KEY", "MODEL_KEY"], channel: ["SLACK_APP_TOKEN"] });
	});

	test("channel refs need a workspace value, not the agent's", () => {
		const missing = unstoredSecretRefs(
			config,
			[
				{ name: "MODEL_KEY", agent_id: "" },
				{ name: "E2B_API_KEY", agent_id: "" },
				{ name: "SLACK_APP_TOKEN", agent_id: "agt_1" },
			],
			"agt_1",
		);
		expect(missing).toEqual({ agent: [], channel: ["SLACK_APP_TOKEN"] });
	});
});

describe("secretValuePrefix", () => {
	test("previews long values, masks short ones", () => {
		expect(secretValuePrefix("e2b_1234567890")).toBe("e2b_***");
		expect(secretValuePrefix("short")).toBe("***");
	});
});
