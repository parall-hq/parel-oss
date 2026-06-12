import type { AgentConfig, PluginDeclaration, PluginFullForm } from "./types/config.js";

/**
 * Secret references — the `${NAME}` placeholder contract for agent configs.
 *
 * A config string value that is EXACTLY a `${NAME}` placeholder (uppercase
 * env-var style) is a *secret reference*: the value is supplied out-of-band
 * (CLI deploy uploads it from the local environment; the platform stores it
 * encrypted, org- or agent-scoped) and substituted only when a session starts.
 * The reference itself is what travels in git, in the stored agent config,
 * and in read-scope API responses — never the value.
 *
 * Whole-value match only: string interpolation (`"https://${HOST}/x"`) is
 * deliberately NOT supported. This module is the SSOT for the reference
 * syntax, shared by the CLI (deploy-time collection), the runtime
 * (session-start resolution), and consoles (readiness display).
 */
export const SECRET_REF_PATTERN = /^\$\{([A-Z][A-Z0-9_]*)\}$/;

/** Returns the referenced name if `value` is a secret reference, else null. */
export function parseSecretRef(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const match = SECRET_REF_PATTERN.exec(value);
	return match ? match[1] : null;
}

/** Renders a name back to its `${NAME}` reference form. */
export function formatSecretRef(name: string): string {
	return `\${${name}}`;
}

export interface MissingSecretRef {
	/** Referenced name that the lookup could not satisfy. */
	name: string;
	/** Dot/bracket path of the referencing field within the walked value. */
	path: string;
}

/** Collects referenced names anywhere in a config subtree (deduped, sorted). */
export function collectSecretRefs(value: unknown): string[] {
	const names = new Set<string>();
	walk(value, (v) => {
		const name = parseSecretRef(v);
		if (name) names.add(name);
	});
	return [...names].sort();
}

/**
 * Collects referenced names across the secret-bearing subtrees of an agent
 * config: `model.config` plus every plugin's `config` (all three declaration
 * forms). Platform-owned fields (agent name, runtime limits, plugin sources)
 * do not participate in the reference contract.
 */
export function collectAgentSecretRefs(config: AgentConfig): string[] {
	const names = new Set<string>();
	const subtrees: unknown[] = [config.model?.config, ...pluginConfigsOf(config.plugins)];
	for (const subtree of subtrees) {
		for (const name of collectSecretRefs(subtree)) names.add(name);
	}
	return [...names].sort();
}

/**
 * Replaces every secret reference in `value` via `lookup`, returning a deep
 * copy. References the lookup cannot satisfy are left as-is and reported in
 * `missing` so the caller decides whether that is fatal (runtime setup) or
 * informational (doctor).
 */
export function resolveSecretRefs<T>(
	value: T,
	lookup: (name: string) => string | undefined,
): { resolved: T; missing: MissingSecretRef[] } {
	const missing: MissingSecretRef[] = [];
	const resolved = rewrite(value, "", lookup, missing) as T;
	return { resolved, missing };
}

/** Extracts the `config` objects from all three plugin declaration forms. */
export function pluginConfigsOf(plugins: PluginDeclaration[] | undefined): unknown[] {
	if (!Array.isArray(plugins)) return [];
	const out: unknown[] = [];
	for (const decl of plugins) {
		if (typeof decl !== "object" || decl === null) continue;
		if ("plugin" in decl) {
			const config = (decl as PluginFullForm).config;
			if (config) out.push(config);
			continue;
		}
		// Id-keyed shorthand: { "<plugin>": { ...config } }
		for (const config of Object.values(decl)) {
			if (config && typeof config === "object") out.push(config);
		}
	}
	return out;
}

function walk(value: unknown, visit: (v: unknown) => void): void {
	visit(value);
	if (Array.isArray(value)) {
		for (const item of value) walk(item, visit);
		return;
	}
	if (value && typeof value === "object") {
		for (const item of Object.values(value)) walk(item, visit);
	}
}

function rewrite(
	value: unknown,
	path: string,
	lookup: (name: string) => string | undefined,
	missing: MissingSecretRef[],
): unknown {
	const name = parseSecretRef(value);
	if (name) {
		const resolved = lookup(name);
		if (resolved === undefined) {
			missing.push({ name, path });
			return value;
		}
		return resolved;
	}
	if (Array.isArray(value)) {
		return value.map((item, i) => rewrite(item, `${path}[${i}]`, lookup, missing));
	}
	if (value && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [key, item] of Object.entries(value)) {
			out[key] = rewrite(item, path ? `${path}.${key}` : key, lookup, missing);
		}
		return out;
	}
	return value;
}
