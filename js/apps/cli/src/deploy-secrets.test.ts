import { describe, expect, test } from "vitest";
import { gatherDeploySecrets, parseSecretOverrides, secretValuePrefix } from "./deploy-secrets.js";

const agent = (plugins: Array<Record<string, unknown>>, modelConfig = {}) => ({
	modelConfig,
	plugins: plugins.map((config) => ({ config })),
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

describe("secretValuePrefix", () => {
	test("previews long values, masks short ones", () => {
		expect(secretValuePrefix("e2b_1234567890")).toBe("e2b_***");
		expect(secretValuePrefix("short")).toBe("***");
	});
});
