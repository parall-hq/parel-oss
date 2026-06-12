import { collectSecretRefs, formatSecretRef, parseSecretRef } from "@parel/core";

/**
 * Deploy-time secret logistics, kept free of process/fs access so it is unit
 * testable: the CLI feeds in the parsed agent config, `--secret` overrides,
 * and (a copy of) the local environment.
 */

export interface DeploySecret {
	name: string;
	value: string;
	source: string;
}

export function isValidSecretName(name: string): boolean {
	return parseSecretRef(formatSecretRef(name)) !== null;
}

export function secretValuePrefix(value: string): string {
	return value.length > 8 ? `${value.slice(0, 4)}***` : "***";
}

/** Parses repeatable `--secret NAME=value` flags. Throws on malformed input. */
export function parseSecretOverrides(raw: unknown): Record<string, string> {
	const items = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
	const out: Record<string, string> = {};
	for (const item of items) {
		const text = String(item);
		const eq = text.indexOf("=");
		if (eq <= 0) throw new Error(`Invalid --secret (expected NAME=value): ${text}`);
		const name = text.slice(0, eq);
		if (!isValidSecretName(name))
			throw new Error(`Invalid secret name (use UPPER_SNAKE_CASE): ${name}`);
		out[name] = text.slice(eq + 1);
	}
	return out;
}

/**
 * Satisfies every `${NAME}` referenced by the config from `--secret` overrides
 * first, then the provided environment. Only referenced names are ever read —
 * never the whole environment. Names with no local value are left for the
 * server to check against the org/agent store; the deploy fails there if they
 * are missing everywhere.
 */
export function gatherDeploySecrets(
	agent: {
		modelConfig: Record<string, unknown>;
		plugins: Array<{ config: Record<string, unknown> }>;
	},
	overrides: Record<string, string>,
	env: Record<string, string | undefined>,
): DeploySecret[] {
	const names = new Set<string>(collectSecretRefs(agent.modelConfig));
	for (const plugin of agent.plugins) {
		for (const name of collectSecretRefs(plugin.config)) names.add(name);
	}
	for (const name of Object.keys(overrides)) {
		if (!names.has(name))
			throw new Error(`--secret ${name} does not match any ${formatSecretRef(name)} in the config`);
	}
	const uploads: DeploySecret[] = [];
	for (const name of [...names].sort()) {
		if (overrides[name] !== undefined) {
			uploads.push({ name, value: overrides[name], source: "--secret" });
		} else {
			const value = env[name];
			if (value) uploads.push({ name, value, source: "local env" });
		}
	}
	return uploads;
}
