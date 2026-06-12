import { describe, expect, test } from "vitest";
import {
	collectAgentSecretRefs,
	collectSecretRefs,
	formatSecretRef,
	parseSecretRef,
	resolveSecretRefs,
} from "../secret-refs.js";
import type { AgentConfig } from "../types/config.js";

describe("parseSecretRef", () => {
	test("matches whole-value uppercase references", () => {
		expect(parseSecretRef("${E2B_API_KEY}")).toBe("E2B_API_KEY");
		expect(parseSecretRef("${A}")).toBe("A");
		expect(parseSecretRef("${A1_B2}")).toBe("A1_B2");
	});

	test("rejects everything else", () => {
		expect(parseSecretRef("${lower_case}")).toBeNull();
		expect(parseSecretRef("${1LEADING_DIGIT}")).toBeNull();
		expect(parseSecretRef("prefix ${E2B_API_KEY}")).toBeNull(); // no interpolation
		expect(parseSecretRef("${E2B_API_KEY} suffix")).toBeNull();
		expect(parseSecretRef("$E2B_API_KEY")).toBeNull();
		expect(parseSecretRef("E2B_API_KEY")).toBeNull();
		expect(parseSecretRef("")).toBeNull();
		expect(parseSecretRef(42)).toBeNull();
		expect(parseSecretRef(null)).toBeNull();
		expect(parseSecretRef({ name: "${X}" })).toBeNull();
	});

	test("formatSecretRef round-trips", () => {
		expect(formatSecretRef("E2B_API_KEY")).toBe("${E2B_API_KEY}");
		expect(parseSecretRef(formatSecretRef("E2B_API_KEY"))).toBe("E2B_API_KEY");
	});
});

describe("collectSecretRefs", () => {
	test("walks nested objects and arrays, dedupes and sorts", () => {
		const refs = collectSecretRefs({
			apiKey: "${B_KEY}",
			nested: { token: "${A_TOKEN}", again: "${B_KEY}" },
			list: ["${C_LIST}", "plain", 7],
			notRef: "use ${NOT_WHOLE} here",
		});
		expect(refs).toEqual(["A_TOKEN", "B_KEY", "C_LIST"]);
	});

	test("handles non-object input", () => {
		expect(collectSecretRefs("${X}")).toEqual(["X"]);
		expect(collectSecretRefs(undefined)).toEqual([]);
		expect(collectSecretRefs(null)).toEqual([]);
	});
});

describe("collectAgentSecretRefs", () => {
	test("covers model.config and all three plugin declaration forms", () => {
		const config = {
			version: "1",
			model: {
				provider: "openai-compatible",
				model: "x",
				config: { apiKey: "${MODEL_KEY}" },
			},
			plugins: [
				"bare-plugin",
				{ plugin: "@parel/sandbox-e2b", config: { apiKey: "${E2B_API_KEY}" } },
				{ "system-static": { prompt: "be concise", token: "${SHORTHAND_TOKEN}" } },
			],
			runtime: {},
		} as unknown as AgentConfig;
		expect(collectAgentSecretRefs(config)).toEqual(["E2B_API_KEY", "MODEL_KEY", "SHORTHAND_TOKEN"]);
	});

	test("ignores platform-owned fields and configless plugins", () => {
		const config = {
			version: "1",
			agent: { name: "${NOT_A_REF_SLOT}" },
			model: { provider: "anthropic", model: "m" },
			plugins: [{ plugin: "@parel/workspace" }],
			runtime: {},
		} as unknown as AgentConfig;
		expect(collectAgentSecretRefs(config)).toEqual([]);
	});
});

describe("resolveSecretRefs", () => {
	test("substitutes whole-value references and reports missing with paths", () => {
		const input = {
			apiKey: "${FOUND}",
			nested: { token: "${MISSING_ONE}" },
			list: ["${FOUND}", "${MISSING_TWO}"],
			plain: "stays",
		};
		const { resolved, missing } = resolveSecretRefs(input, (name) =>
			name === "FOUND" ? "sk-value" : undefined,
		);
		expect(resolved).toEqual({
			apiKey: "sk-value",
			nested: { token: "${MISSING_ONE}" },
			list: ["sk-value", "${MISSING_TWO}"],
			plain: "stays",
		});
		expect(missing).toEqual([
			{ name: "MISSING_ONE", path: "nested.token" },
			{ name: "MISSING_TWO", path: "list[1]" },
		]);
	});

	test("does not mutate the input", () => {
		const input = { apiKey: "${X}" };
		const { resolved } = resolveSecretRefs(input, () => "v");
		expect(input.apiKey).toBe("${X}");
		expect(resolved.apiKey).toBe("v");
	});

	test("resolves an empty-string value (defined beats truthy)", () => {
		const { resolved, missing } = resolveSecretRefs({ k: "${EMPTY}" }, () => "");
		expect(resolved.k).toBe("");
		expect(missing).toEqual([]);
	});
});
