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

/** The parts of an agent config that can hold `${NAME}` references. */
export interface SecretRefConfig {
	modelConfig: Record<string, unknown>;
	plugins: Array<{ config: Record<string, unknown> }>;
	channels?: Array<{ config: Record<string, unknown> }>;
}

/** A stored secret as `GET /secrets` lists it (values never leave the server). */
export interface StoredSecret {
	name: string;
	/** Empty string = workspace-wide; otherwise the owning agent id. */
	agent_id: string;
	/** Set for a value that only one instance of the agent sees. */
	instance_id?: string | null;
}

export function isValidSecretName(name: string): boolean {
	return parseSecretRef(formatSecretRef(name)) !== null;
}

export function secretValuePrefix(value: string): string {
	return value.length > 8 ? `${value.slice(0, 4)}***` : "***";
}

/**
 * `${NAME}` references anywhere in `model.config` and the plugin configs. The
 * server requires each to resolve (from the deploy, this agent's stored values,
 * or the workspace's) before it accepts a deploy.
 */
export function agentSecretRefs(config: SecretRefConfig): string[] {
	const names = new Set<string>(collectSecretRefs(config.modelConfig));
	for (const plugin of config.plugins) {
		for (const name of collectSecretRefs(plugin.config)) names.add(name);
	}
	return [...names].sort();
}

/**
 * `${NAME}` references in `channels[].config`. Only top-level values count, as on
 * the server: a channel connection reads them from the workspace's secrets.
 */
export function channelSecretRefs(config: SecretRefConfig): string[] {
	const names = new Set<string>();
	for (const channel of config.channels ?? []) {
		for (const value of Object.values(channel.config)) {
			const name = parseSecretRef(value);
			if (name) names.add(name);
		}
	}
	return [...names].sort();
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
 * Satisfies every `${NAME}` referenced by the config (model, plugins and
 * channels) from `--secret` overrides first, then the provided environment.
 * Only referenced names are ever read — never the whole environment. Names with
 * no local value are left for the server to check against the stored secrets;
 * the deploy fails there if they are missing everywhere.
 */
export function gatherDeploySecrets(
	config: SecretRefConfig,
	overrides: Record<string, string>,
	env: Record<string, string | undefined>,
): DeploySecret[] {
	const names = new Set([...agentSecretRefs(config), ...channelSecretRefs(config)]);
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

/**
 * References the server can't resolve from what is already stored, for a deploy
 * that carries no values (a staged version of an existing agent). Model and
 * plugin references resolve from the workspace's or this agent's own values;
 * channel references from the workspace's only. Instance values don't count.
 */
export function unstoredSecretRefs(
	config: SecretRefConfig,
	stored: StoredSecret[],
	agentId: string,
): { agent: string[]; channel: string[] } {
	const shared = stored.filter((row) => !row.instance_id);
	const forAgent = new Set(
		shared.filter((row) => row.agent_id === "" || row.agent_id === agentId).map((row) => row.name),
	);
	const forWorkspace = new Set(shared.filter((row) => row.agent_id === "").map((row) => row.name));
	return {
		agent: agentSecretRefs(config).filter((name) => !forAgent.has(name)),
		channel: channelSecretRefs(config).filter((name) => !forWorkspace.has(name)),
	};
}
