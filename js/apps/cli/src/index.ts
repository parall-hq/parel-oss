import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { collectSecretRefs, formatSecretRef, parseSecretRef } from "@parel/core";
import { defineCommand, runMain } from "citty";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import pkg from "../package.json" with { type: "json" };
import {
	type DeploySecret,
	gatherDeploySecrets,
	isValidSecretName,
	parseSecretOverrides,
	secretValuePrefix,
} from "./deploy-secrets.js";
import { sessionWebSocketRequest } from "./ws-auth.js";

// ── Exit codes ─────────────────────────────────────────────────────

const EXIT_CLI = 1;
const EXIT_API = 2;
const EXIT_TIMEOUT = 3;
const EXIT_REQUIREMENTS = 4;

// ── Output mode ────────────────────────────────────────────────────
// PAREL_JSON=1 env var makes ALL commands output machine-readable JSON.
// Per-command --json flag does the same for a single invocation.

const globalJson = !!process.env.PAREL_JSON;
const isColor = !globalJson && process.stdout.isTTY !== false && !process.env.NO_COLOR;

function wantsJson(args: { json?: boolean }): boolean {
	return globalJson || !!args.json;
}

function output(data: unknown, args: { json?: boolean }): void {
	console.log(JSON.stringify(data, null, wantsJson(args) ? undefined : 2));
}

function outputSuccess(data: unknown, humanMsg: string, args: { json?: boolean }): void {
	if (wantsJson(args)) {
		console.log(JSON.stringify(data));
	} else {
		console.log(humanMsg);
	}
}

let _cmdJson = false;

function fail(msg: string, code: number): never {
	if (globalJson || _cmdJson) {
		console.log(JSON.stringify({ error: msg }));
	} else {
		console.error(c.red(`Error: ${msg}`));
	}
	process.exit(code);
}

// ── ANSI (disabled in JSON mode) ───────────────────────────────────

const c = {
	green: (s: string) => (isColor ? `\x1b[32m${s}\x1b[0m` : s),
	dim: (s: string) => (isColor ? `\x1b[2m${s}\x1b[0m` : s),
	cyan: (s: string) => (isColor ? `\x1b[36m${s}\x1b[0m` : s),
	red: (s: string) => (isColor ? `\x1b[31m${s}\x1b[0m` : s),
	yellow: (s: string) => (isColor ? `\x1b[33m${s}\x1b[0m` : s),
	bold: (s: string) => (isColor ? `\x1b[1m${s}\x1b[0m` : s),
};

// ── Config ──────────────────────────────────────────────────────────

const CONFIG_DIR = join(homedir(), ".parel");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");

interface PaRelConfig {
	server: string;
	apiKey?: string;
}

function loadConfig(): PaRelConfig {
	try {
		if (existsSync(CONFIG_FILE)) return JSON.parse(readFileSync(CONFIG_FILE, "utf-8"));
	} catch {}
	return { server: process.env.PAREL_SERVER ?? "https://api.parel.sh" };
}

function saveConfig(config: PaRelConfig): void {
	mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
	writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), { mode: 0o600 });
}

function resolveServer(args: { server?: string }): string {
	const server = args.server ?? process.env.PAREL_SERVER ?? loadConfig().server;
	assertSecureUrl(server);
	return server;
}

function resolveApiKey(): string | undefined {
	return process.env.PAREL_API_KEY ?? loadConfig().apiKey;
}

function authHeaders(): Record<string, string> {
	const key = resolveApiKey();
	if (key) return { Authorization: `Bearer ${key}` };
	return {};
}

function requireAuth(args?: Record<string, unknown>): void {
	if (args) _cmdJson = !!args.json;
	if (!resolveApiKey())
		fail("Not authenticated. Set PAREL_API_KEY or run `parel login`.", EXIT_CLI);
}

// ── API / Helpers ───────────────────────────────────────────────────

function assertSecureUrl(url: string): void {
	const parsed = new URL(url);
	const isLocal = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
	if (parsed.protocol !== "https:" && !isLocal)
		fail(
			`Refusing to send credentials over insecure ${parsed.protocol}// — use HTTPS or localhost`,
			EXIT_CLI,
		);
}

async function apiFetch(base: string, path: string, init?: RequestInit): Promise<Response> {
	assertSecureUrl(base);
	const headers = { ...authHeaders(), ...Object.fromEntries(new Headers(init?.headers).entries()) };
	const res = await fetch(`${base}${path}`, { ...init, headers });
	if (!res.ok) {
		const body = await res.text().catch(() => "");
		let msg = `${res.status} ${res.statusText}`;
		try {
			const json = JSON.parse(body);
			if (json.error) msg = json.error;
		} catch {
			if (body) msg += `: ${body}`;
		}
		throw new ApiError(msg, res.status);
	}
	return res;
}

class ApiError extends Error {
	constructor(
		message: string,
		public status: number,
	) {
		super(message);
	}
}

function handleError(err: unknown): never {
	const msg = err instanceof Error ? err.message : String(err);
	const code = err instanceof ApiError ? EXIT_API : EXIT_CLI;
	fail(msg, code);
}

function printTable(rows: Record<string, unknown>[]): void {
	if (rows.length === 0) {
		console.log(c.dim("  (no results)"));
		return;
	}
	const keys = Object.keys(rows[0]);
	const widths = keys.map((k) => Math.max(k.length, ...rows.map((r) => String(r[k] ?? "").length)));
	console.log(c.dim(keys.map((k, i) => k.toUpperCase().padEnd(widths[i])).join("  ")));
	console.log(c.dim(widths.map((w) => "─".repeat(w)).join("──")));
	for (const row of rows)
		console.log(keys.map((k, i) => String(row[k] ?? "").padEnd(widths[i])).join("  "));
}

async function readStdin(): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
	return Buffer.concat(chunks).toString("utf-8").trim();
}

type JsonArgs = { json?: boolean };

interface ProviderKeyRow {
	id: string;
	provider: string;
	key_prefix: string;
	created_at?: string;
}

interface SecretRow {
	id: string;
	name: string;
	/** Empty string = org-scoped; otherwise the owning agent id. */
	agent_id: string;
	value_prefix: string;
	created_at?: string;
	updated_at?: string;
}

interface ProviderAvailability {
	provider: string;
	managed?: boolean;
	byok?: boolean;
	source?: "byok" | "platform" | "none" | string;
}

interface ParsedAgentConfig {
	modelProvider: string;
	modelConfig: Record<string, unknown>;
	plugins: ParsedPlugin[];
}

interface ParsedPlugin {
	packageName: string;
	version?: string;
	source?: PluginSource;
	config: Record<string, unknown>;
}

interface PluginSource {
	type: "path";
	path: string;
}

interface LocalPluginArtifact {
	name: string;
	version: string;
	integrity: string;
	artifactKey: string;
	manifest?: unknown;
}

interface LocalPluginDeclaration {
	index: number;
	packageName?: string;
	version?: string;
	sourcePath: string;
}

type RequirementSpec =
	| { type: "provider_key"; provider: string; env: string }
	/** `suggestedName` is the conventional `${NAME}` reference for this field. */
	| { type: "plugin_secret"; plugin: string; key: string; suggestedName: string };

interface CapabilityDefinition {
	id: string;
	label: string;
	description: string;
	source:
		| { type: "model"; provider: string; credentialProvider: string }
		| { type: "plugin"; package: string };
	requirements: RequirementSpec[];
}

interface DoctorRequirement {
	type: "provider_key" | "plugin_secret";
	status: "ready" | "ready_byok" | "ready_platform" | "ready_inline" | "missing" | "error_inline";
	provider?: string;
	plugin?: string;
	key?: string;
	env?: string;
	/** The `${NAME}` reference bound to this field, if any. */
	ref?: string;
	/** Where a ready reference resolves from. */
	ref_source?: "local_env" | "org";
	/** Conventional reference name to suggest when the field has no binding. */
	suggested_ref?: string;
}

interface DoctorCapability {
	id: string;
	status:
		| "ready"
		| "ready_byok"
		| "ready_platform"
		| "ready_inline"
		| "missing_provider_key"
		| "missing_secret"
		| "error_inline";
	source:
		| { type: "model"; provider: string; credential_provider: string }
		| { type: "plugin"; package: string };
	requirements: DoctorRequirement[];
	fixes: { kind: "command"; command: string }[];
	warnings?: string[];
}

/** Resolution status of one `${NAME}` reference across the whole config. */
interface DoctorSecretRef {
	name: string;
	status: "ready_local_env" | "ready_org" | "missing";
	fixes: { kind: "command"; command: string }[];
}

interface CapabilityDoctorReport {
	schema_version: "parel.capability_doctor.v2";
	ok: boolean;
	agent_file: string;
	capabilities: DoctorCapability[];
	secret_refs: DoctorSecretRef[];
	warnings?: string[];
}

const CAPABILITY_REGISTRY: CapabilityDefinition[] = [
	{
		id: "model.anthropic",
		label: "Anthropic models",
		description: "Use the Anthropic model provider layer.",
		source: { type: "model", provider: "anthropic", credentialProvider: "anthropic" },
		requirements: [{ type: "provider_key", provider: "anthropic", env: "ANTHROPIC_API_KEY" }],
	},
	{
		id: "model.openai",
		label: "OpenAI models",
		description: "Use the OpenAI model provider layer, including OpenAI Responses.",
		source: { type: "model", provider: "openai", credentialProvider: "openai" },
		requirements: [{ type: "provider_key", provider: "openai", env: "OPENAI_API_KEY" }],
	},
	{
		id: "sandbox.e2b",
		label: "E2B sandbox",
		description: "Run filesystem and shell tools inside an E2B code-interpreter sandbox.",
		source: { type: "plugin", package: "@parel/sandbox-e2b" },
		requirements: [
			{
				type: "plugin_secret",
				plugin: "@parel/sandbox-e2b",
				key: "apiKey",
				suggestedName: "E2B_API_KEY",
			},
		],
	},
	{
		id: "memory.rolling-summary",
		label: "Rolling summary memory",
		description: "Compact older history into a rolling summary.",
		source: { type: "plugin", package: "@parel/memory-rolling-summary" },
		requirements: [],
	},
	{
		id: "budget.cap",
		label: "Budget cap",
		description: "Stop execution when configured spend or turn limits are reached.",
		source: { type: "plugin", package: "@parel/budget-cap" },
		requirements: [],
	},
	{
		id: "security.basic",
		label: "Basic security policy",
		description: "Apply basic command policy and redaction controls.",
		source: { type: "plugin", package: "@parel/security-basic" },
		requirements: [],
	},
	{
		id: "system.static",
		label: "Static system prompt",
		description: "Inject a configured static system prompt.",
		source: { type: "plugin", package: "@parel/system-static" },
		requirements: [],
	},
	{
		id: "steering.immediate",
		label: "Immediate steering",
		description: "Apply user steering messages to running sessions.",
		source: { type: "plugin", package: "@parel/steering-immediate" },
		requirements: [],
	},
	{
		id: "subagent",
		label: "Subagent delegation",
		description: "Delegate work to child agents when the runtime supports it.",
		source: { type: "plugin", package: "@parel/subagent" },
		requirements: [],
	},
];

const CAPABILITY_BY_ID = new Map(CAPABILITY_REGISTRY.map((cap) => [cap.id, cap]));
const CAPABILITY_BY_PLUGIN = new Map(
	CAPABILITY_REGISTRY.flatMap((cap) =>
		cap.source.type === "plugin" ? [[cap.source.package, cap] as const] : [],
	),
);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isLocalPluginPath(value: string): boolean {
	return value.startsWith("./") || value.startsWith("../") || value.startsWith("/");
}

function pluginSourceValue(value: unknown): PluginSource | undefined {
	if (!isRecord(value)) return undefined;
	if (value.type !== "path") return undefined;
	const path = stringValue(value.path);
	if (!path) return undefined;
	return { type: "path", path };
}

function normalizePluginName(name: string): string {
	const trimmed = name.trim();
	if (isLocalPluginPath(trimmed)) return trimmed;
	if (trimmed.startsWith("@")) return trimmed;
	return `@parel/${trimmed}`;
}

function envNameForProvider(provider: string): string {
	return `${provider.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`;
}

function providerFixCommand(provider: string, env = envNameForProvider(provider)): string {
	return `parel provider-keys set ${provider} --from-env ${env}`;
}

/** `parel secrets set NAME` reads the value from the same-named env var by default. */
function secretFixCommand(name: string): string {
	return `parel secrets set ${name}`;
}

function exportFixCommand(name: string, file: string): string {
	return `export ${name}=... && parel deploy ${file}`;
}

function bindingFixHint(plugin: string, key: string, suggestedName: string): string {
	return `add \`${key}: ${formatSecretRef(suggestedName)}\` to the ${plugin} config block`;
}

function parsePluginDeclaration(raw: unknown): ParsedPlugin | null {
	if (typeof raw === "string") return { packageName: normalizePluginName(raw), config: {} };
	if (!isRecord(raw)) return null;

	const explicitPlugin = stringValue(raw.plugin);
	if (explicitPlugin) {
		return {
			packageName: normalizePluginName(explicitPlugin),
			version: stringValue(raw.version),
			source: pluginSourceValue(raw.source),
			config: isRecord(raw.config) ? raw.config : {},
		};
	}

	const entry = Object.entries(raw).find(([key]) => key !== "version" && key !== "config");
	if (!entry) return null;
	const [pluginName, config] = entry;
	return {
		packageName: normalizePluginName(pluginName),
		config: isRecord(config) ? config : {},
	};
}

function readAgentConfig(file: string): ParsedAgentConfig {
	if (!existsSync(file)) fail(`File not found: ${file}`, EXIT_CLI);

	const raw = parseYaml(readFileSync(file, "utf-8")) as unknown;
	if (!isRecord(raw)) throw new Error("agent config must be a YAML object");
	if (!isRecord(raw.model)) throw new Error("model is required");

	const modelProvider = stringValue(raw.model.provider);
	if (!modelProvider) throw new Error("model.provider is required");

	const pluginsRaw = Array.isArray(raw.plugins) ? raw.plugins : [];
	return {
		modelProvider,
		modelConfig: isRecord(raw.model.config) ? raw.model.config : {},
		plugins: pluginsRaw.map(parsePluginDeclaration).filter((p): p is ParsedPlugin => p !== null),
	};
}

/** The `agent.name` declared in the config, used to address the versions
 *  resource (`POST /agents/:name/versions`). Undefined when the config omits it. */
function readAgentName(file: string): string | undefined {
	const raw = parseYaml(readFileSync(file, "utf-8")) as unknown;
	if (!isRecord(raw) || !isRecord(raw.agent)) return undefined;
	return stringValue(raw.agent.name);
}

function readJsonFile(file: string): Record<string, unknown> {
	try {
		const parsed = JSON.parse(readFileSync(file, "utf-8")) as unknown;
		if (!isRecord(parsed)) throw new Error("must be a JSON object");
		return parsed;
	} catch (err) {
		throw new Error(`${file}: ${err instanceof Error ? err.message : String(err)}`);
	}
}

function integrityFor(bytes: Buffer): string {
	return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}

function localPluginDeclarations(configText: string, agentFile: string): LocalPluginDeclaration[] {
	const raw = parseYaml(configText) as unknown;
	if (!isRecord(raw)) return [];
	const pluginsRaw = Array.isArray(raw.plugins) ? raw.plugins : [];
	const out: LocalPluginDeclaration[] = [];
	for (const [index, entry] of pluginsRaw.entries()) {
		if (typeof entry === "string" && isLocalPluginPath(entry)) {
			out.push({ index, sourcePath: entry });
			continue;
		}
		if (!isRecord(entry)) continue;
		const explicitPlugin = stringValue(entry.plugin);
		if (explicitPlugin && isLocalPluginPath(explicitPlugin)) {
			out.push({
				index,
				version: stringValue(entry.version),
				sourcePath: explicitPlugin,
			});
			continue;
		}
		const source = pluginSourceValue(entry.source);
		if (!source) continue;
		if (!explicitPlugin) {
			throw new Error(`Local plugin source in ${agentFile} must use full plugin form`);
		}
		out.push({
			index,
			packageName: normalizePluginName(explicitPlugin),
			version: stringValue(entry.version),
			sourcePath: source.path,
		});
	}
	return out;
}

function canonicalizeLocalPluginSources(
	configText: string,
	local: LocalPluginDeclaration[],
	packed: Array<{ name: string }>,
): string {
	const raw = parseYaml(configText) as unknown;
	if (!isRecord(raw) || !Array.isArray(raw.plugins)) return configText;
	const plugins = [...raw.plugins];
	for (let i = 0; i < local.length; i++) {
		const decl = local[i];
		const entry = plugins[decl.index];
		const canonical = {
			...(isRecord(entry) ? entry : {}),
			plugin: packed[i].name,
			source: { type: "path", path: decl.sourcePath },
		};
		plugins[decl.index] = canonical;
	}
	return stringifyYaml({ ...raw, plugins });
}

function findPackedTarball(tmpDir: string, output: string): string {
	try {
		const parsed = JSON.parse(output.trim()) as
			| { filename?: string }
			| Array<{ filename?: string }>;
		const filename = Array.isArray(parsed) ? parsed[0]?.filename : parsed.filename;
		if (filename) {
			const candidate = isAbsolute(filename) ? filename : join(tmpDir, filename);
			if (existsSync(candidate)) return candidate;
		}
	} catch {
		// Fall back to scanning below.
	}
	const tgz = readdirSync(tmpDir).find((name) => name.endsWith(".tgz"));
	if (!tgz) throw new Error("npm pack did not produce a .tgz file");
	return join(tmpDir, tgz);
}

function pluginPackCommand(): { cmd: string; args: string[] } {
	try {
		execFileSync("pnpm", ["--version"], { stdio: "ignore" });
		return { cmd: "pnpm", args: ["pack", "--json"] };
	} catch {
		return { cmd: "npm", args: ["pack", "--json"] };
	}
}

function packLocalPlugin(
	decl: LocalPluginDeclaration,
	agentFile: string,
): { bytes: Buffer; integrity: string; name: string; version: string; manifest: unknown } {
	const pluginDir = resolve(dirname(agentFile), decl.sourcePath);
	if (!existsSync(pluginDir) || !statSync(pluginDir).isDirectory()) {
		throw new Error(`Local plugin path not found: ${decl.sourcePath}`);
	}

	const pkgJson = readJsonFile(join(pluginDir, "package.json"));
	const name = stringValue(pkgJson.name);
	const version = stringValue(pkgJson.version);
	if (!name) throw new Error(`${decl.sourcePath}/package.json must declare name`);
	if (!version) throw new Error(`${decl.sourcePath}/package.json must declare version`);
	if (decl.packageName && name !== decl.packageName) {
		throw new Error(
			`Local plugin name mismatch: agent.yaml declares ${decl.packageName}, package.json declares ${name}`,
		);
	}

	const manifestPath = join(pluginDir, "parel.plugin.json");
	if (!existsSync(manifestPath)) {
		throw new Error(`Local plugin ${name} must include parel.plugin.json`);
	}
	const manifest = readJsonFile(manifestPath);

	const tmpDir = mkdtempSync(join(tmpdir(), "parel-plugin-"));
	try {
		const pack = pluginPackCommand();
		const output = execFileSync(pack.cmd, [...pack.args, "--pack-destination", tmpDir], {
			cwd: pluginDir,
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "pipe"],
		});
		const tarball = findPackedTarball(tmpDir, output);
		const bytes = readFileSync(tarball);
		return { bytes, integrity: integrityFor(bytes), name, version, manifest };
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
	}
}

async function uploadLocalPluginArtifact(
	server: string,
	packed: { bytes: Buffer; integrity: string; name: string; version: string; manifest: unknown },
): Promise<LocalPluginArtifact> {
	const params = new URLSearchParams({
		name: packed.name,
		version: packed.version,
		integrity: packed.integrity,
	});
	const res = await apiFetch(server, `/plugin-artifacts?${params.toString()}`, {
		method: "POST",
		headers: { "Content-Type": "application/octet-stream" },
		body: packed.bytes,
	});
	const uploaded = (await res.json()) as { artifactKey?: string; integrity?: string };
	if (!uploaded.artifactKey) throw new Error(`Artifact upload for ${packed.name} returned no key`);
	return {
		name: packed.name,
		version: packed.version,
		integrity: uploaded.integrity ?? packed.integrity,
		artifactKey: uploaded.artifactKey,
		manifest: packed.manifest,
	};
}

async function buildAgentDeployRequest(
	file: string,
	server: string,
	secrets: DeploySecret[],
): Promise<{ headers: Record<string, string>; body: string }> {
	const config = readFileSync(file, "utf-8");
	const local = localPluginDeclarations(config, file);
	if (local.length === 0 && secrets.length === 0) {
		return { headers: { "Content-Type": "text/yaml" }, body: config };
	}

	const artifacts: LocalPluginArtifact[] = [];
	const packedPlugins: Array<{ name: string }> = [];
	for (const decl of local) {
		const packed = packLocalPlugin(decl, file);
		packedPlugins.push({ name: packed.name });
		artifacts.push(await uploadLocalPluginArtifact(server, packed));
	}

	return {
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			config:
				local.length > 0 ? canonicalizeLocalPluginSources(config, local, packedPlugins) : config,
			...(artifacts.length > 0 ? { pluginArtifacts: artifacts } : {}),
			...(secrets.length > 0
				? { secrets: Object.fromEntries(secrets.map((s) => [s.name, s.value])) }
				: {}),
		}),
	};
}

async function deployAgentFile(
	server: string,
	file: string,
	path: string,
	opts: { args: JsonArgs; secretOverrides?: Record<string, string> },
): Promise<{
	id: string;
	name: string;
	version?: number;
	versionId?: string;
	active?: boolean;
	uploaded_secrets: Array<{ name: string; source: string }>;
}> {
	const secrets = gatherDeploySecrets(
		readAgentConfig(file),
		opts.secretOverrides ?? {},
		process.env,
	);
	if (secrets.length > 0 && !wantsJson(opts.args)) {
		console.log(c.bold("Secrets"));
		for (const s of secrets) {
			console.log(
				`  ${c.green("✓")} ${s.name}  ${c.dim(`from ${s.source} → agent-level (${secretValuePrefix(s.value)})`)}`,
			);
		}
	}
	const req = await buildAgentDeployRequest(file, server, secrets);
	const res = await apiFetch(server, path, {
		method: "POST",
		headers: req.headers,
		body: req.body,
	});
	const agent = (await res.json()) as {
		id: string;
		name: string;
		version?: number;
		versionId?: string;
		active?: boolean;
	};
	return {
		...agent,
		uploaded_secrets: secrets.map((s) => ({ name: s.name, source: s.source })),
	};
}

// All session creation goes through the top-level resource route
// (docs/agent-instance-model.md §5.2): the agent reference travels in the body,
// with an optional named instance alongside it. The server always returns status.
async function createSession(
	server: string,
	body: { agent: string; instance?: string },
): Promise<{ id: string; status: string; instance?: string }> {
	const res = await apiFetch(server, "/sessions", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	return (await res.json()) as { id: string; status: string; instance?: string };
}

function credentialProviderForModel(provider: string, config: Record<string, unknown>): string {
	if (provider === "anthropic") return "anthropic";
	if (provider === "openai" || provider === "openai-responses") return "openai";
	if (provider === "openai-compatible" || provider === "anthropic-compatible")
		return stringValue(config.credentialProvider) ?? provider;
	return provider;
}

function modelCapabilityId(provider: string, credentialProvider: string): string {
	if (credentialProvider === "anthropic") return "model.anthropic";
	if (credentialProvider === "openai") return "model.openai";
	return `model.${provider}`;
}

async function listProviderKeys(server: string): Promise<ProviderKeyRow[]> {
	const res = await apiFetch(server, "/provider-keys");
	return (await res.json()) as ProviderKeyRow[];
}

/** Returns [] when the server predates the /secrets endpoint (404). */
async function listSecrets(server: string): Promise<SecretRow[]> {
	try {
		const res = await apiFetch(server, "/secrets");
		return (await res.json()) as SecretRow[];
	} catch (err) {
		if (err instanceof ApiError && err.status === 404) return [];
		throw err;
	}
}

function assertSecretName(name: string): void {
	if (!isValidSecretName(name))
		fail(`Invalid secret name (use UPPER_SNAKE_CASE): ${name}`, EXIT_CLI);
}

async function listProviderAvailability(
	server: string,
): Promise<ProviderAvailability[] | undefined> {
	try {
		const res = await apiFetch(server, "/providers");
		return (await res.json()) as ProviderAvailability[];
	} catch (err) {
		if (err instanceof ApiError && err.status === 404) return undefined;
		throw err;
	}
}

async function readSecretValue(args: { fromEnv?: string; stdin?: boolean }): Promise<{
	value: string;
	source: string;
}> {
	if (!!args.fromEnv === !!args.stdin) fail("Use exactly one of --from-env or --stdin", EXIT_CLI);
	if (args.fromEnv) {
		const value = process.env[args.fromEnv];
		if (!value) fail(`Environment variable is not set: ${args.fromEnv}`, EXIT_CLI);
		return { value, source: `env:${args.fromEnv}` };
	}
	const value = await readStdin();
	if (!value) fail("stdin was empty", EXIT_CLI);
	return { value, source: "stdin" };
}

async function buildCapabilityDoctorReport(
	file: string,
	server: string,
	secretOverrides: Record<string, string> = {},
): Promise<CapabilityDoctorReport> {
	const agent = readAgentConfig(file);
	// Every `${NAME}` anywhere in the config, including plugins the registry
	// does not know about — the reference contract is plugin-agnostic.
	const allRefNames = new Set<string>(collectSecretRefs(agent.modelConfig));
	for (const plugin of agent.plugins) {
		for (const name of collectSecretRefs(plugin.config)) allRefNames.add(name);
	}
	// Reject overrides that match no reference, exactly like the deploy path
	// (gatherDeploySecrets) — otherwise a typo'd --secret name passes doctor
	// but fails the deploy it is meant to predict.
	for (const name of Object.keys(secretOverrides)) {
		if (!allRefNames.has(name))
			throw new Error(`--secret ${name} does not match any ${formatSecretRef(name)} in ${file}`);
	}
	const [providerAvailability, providerKeys, secretRows] = await Promise.all([
		listProviderAvailability(server),
		listProviderKeys(server),
		listSecrets(server),
	]);

	const providerKeySet = new Set(providerKeys.map((row) => row.provider));
	const providerAvailabilityById = new Map(
		(providerAvailability ?? []).map((row) => [row.provider, row]),
	);
	// Doctor checks a file, not a deployed agent, so agent-scoped rows are out
	// of reach here; the resolvable sources are org store, local env, and any
	// `--secret` overrides the deploy would carry ("local_env" covers both
	// deploy-time sources: either way the value uploads with the deploy).
	const orgSecretNames = new Set(secretRows.filter((row) => !row.agent_id).map((row) => row.name));
	const refSource = (name: string): "local_env" | "org" | undefined =>
		secretOverrides[name] !== undefined || process.env[name]
			? "local_env"
			: orgSecretNames.has(name)
				? "org"
				: undefined;
	const refFixes = (name: string): { kind: "command"; command: string }[] => [
		{ kind: "command", command: exportFixCommand(name, file) },
		{ kind: "command", command: secretFixCommand(name) },
	];
	const capabilities: DoctorCapability[] = [];
	const warnings: string[] = [];

	const credentialProvider = credentialProviderForModel(agent.modelProvider, agent.modelConfig);
	const modelKeyRef = parseSecretRef(agent.modelConfig.apiKey);
	const inlineModelKey = modelKeyRef ? undefined : stringValue(agent.modelConfig.apiKey);
	const providerRow = providerAvailabilityById.get(credentialProvider);
	const providerSource = providerRow?.source;
	const providerReady =
		providerSource && providerSource !== "none"
			? providerSource
			: providerKeySet.has(credentialProvider)
				? "byok"
				: undefined;
	const providerEnv =
		CAPABILITY_BY_ID.get(
			modelCapabilityId(agent.modelProvider, credentialProvider),
		)?.requirements.find((req) => req.type === "provider_key")?.env ??
		envNameForProvider(credentialProvider);
	// An agent-supplied model key counts as inline whether it is a literal or a
	// resolvable reference; an unresolvable reference is a missing requirement.
	const modelStatus: DoctorRequirement["status"] = modelKeyRef
		? refSource(modelKeyRef)
			? "ready_inline"
			: "missing"
		: inlineModelKey
			? "ready_inline"
			: providerReady === "platform"
				? "ready_platform"
				: providerReady === "byok"
					? "ready_byok"
					: "missing";
	const modelRequirement: DoctorRequirement = {
		type: "provider_key",
		provider: credentialProvider,
		env: providerEnv,
		status: modelStatus,
		...(modelKeyRef ? { ref: modelKeyRef, ref_source: refSource(modelKeyRef) } : {}),
	};
	capabilities.push({
		id: modelCapabilityId(agent.modelProvider, credentialProvider),
		status:
			modelStatus === "missing"
				? "missing_provider_key"
				: (modelStatus as DoctorCapability["status"]),
		source: {
			type: "model",
			provider: agent.modelProvider,
			credential_provider: credentialProvider,
		},
		requirements: [modelRequirement],
		fixes:
			modelStatus !== "missing"
				? []
				: modelKeyRef
					? refFixes(modelKeyRef)
					: [{ kind: "command", command: providerFixCommand(credentialProvider, providerEnv) }],
	});

	for (const plugin of agent.plugins) {
		const definition = CAPABILITY_BY_PLUGIN.get(plugin.packageName);
		const requirements = definition?.requirements ?? [];
		const capRequirements: DoctorRequirement[] = [];
		const fixes: { kind: "command"; command: string }[] = [];
		const capWarnings: string[] = [];
		let missingSecret = false;
		let inlineLiteral = false;

		for (const req of requirements) {
			if (req.type !== "plugin_secret") continue;
			const raw = plugin.config[req.key];
			const ref = parseSecretRef(raw);
			if (ref) {
				const source = refSource(ref);
				if (!source) {
					missingSecret = true;
					fixes.push(...refFixes(ref));
				}
				capRequirements.push({
					type: "plugin_secret",
					plugin: req.plugin,
					key: req.key,
					ref,
					ref_source: source,
					status: source ? "ready" : "missing",
				});
				continue;
			}
			if (stringValue(raw)) {
				// A literal in a secret-declared field is rejected at deploy time.
				inlineLiteral = true;
				const warning = `${plugin.packageName}/${req.key} is an inline literal; the server rejects this — use ${formatSecretRef(req.suggestedName)} instead.`;
				capWarnings.push(warning);
				warnings.push(warning);
				capRequirements.push({
					type: "plugin_secret",
					plugin: req.plugin,
					key: req.key,
					suggested_ref: req.suggestedName,
					status: "error_inline",
				});
				continue;
			}
			// No binding at all: the field needs a `${NAME}` reference. Storing a
			// value alone is NOT sufficient — the fix must include the config edit.
			missingSecret = true;
			const hint = bindingFixHint(req.plugin, req.key, req.suggestedName);
			capWarnings.push(hint);
			warnings.push(hint);
			fixes.push({
				kind: "command",
				command: `${hint}, then: ${secretFixCommand(req.suggestedName)}`,
			});
			capRequirements.push({
				type: "plugin_secret",
				plugin: req.plugin,
				key: req.key,
				suggested_ref: req.suggestedName,
				status: "missing",
			});
		}

		capabilities.push({
			id: definition?.id ?? `plugin.${plugin.packageName}`,
			status: missingSecret ? "missing_secret" : inlineLiteral ? "error_inline" : "ready",
			source: { type: "plugin", package: plugin.packageName },
			requirements: capRequirements,
			fixes,
			warnings: capWarnings.length > 0 ? capWarnings : undefined,
		});
	}

	const secretRefs: DoctorSecretRef[] = [...allRefNames].sort().map((name) => {
		const source = refSource(name);
		return {
			name,
			status:
				source === "local_env" ? "ready_local_env" : source === "org" ? "ready_org" : "missing",
			fixes: source ? [] : refFixes(name),
		};
	});

	return {
		schema_version: "parel.capability_doctor.v2",
		ok:
			capabilities.every(
				(cap) =>
					cap.status !== "missing_provider_key" &&
					cap.status !== "missing_secret" &&
					cap.status !== "error_inline",
			) && secretRefs.every((ref) => ref.status !== "missing"),
		agent_file: file,
		capabilities,
		secret_refs: secretRefs,
		warnings: warnings.length > 0 ? warnings : undefined,
	};
}

function renderRequirement(req: DoctorRequirement): string {
	if (req.type === "provider_key") return `provider_key:${req.provider}`;
	const binding = req.ref
		? ` (${formatSecretRef(req.ref)})`
		: req.suggested_ref
			? ` (needs ${formatSecretRef(req.suggested_ref)})`
			: "";
	return `plugin_secret:${req.plugin}/${req.key}${binding}`;
}

function renderDoctorReport(report: CapabilityDoctorReport, args: JsonArgs): void {
	if (wantsJson(args)) {
		console.log(JSON.stringify(report));
		return;
	}

	if (report.ok) {
		console.log(c.green(`Ready: ${report.capabilities.length} capabilities checked.`));
	} else {
		console.log(c.yellow(`Not ready: ${report.agent_file}`));
		const rows = report.capabilities
			.flatMap((cap) =>
				cap.requirements
					.filter((req) => req.status === "missing" || req.status === "error_inline")
					.map((req) => ({
						capability: cap.id,
						requirement: renderRequirement(req),
						fix: cap.fixes[0]?.command ?? "",
					})),
			)
			.filter((row) => row.fix);
		printTable(rows);
	}

	if (report.secret_refs.length > 0) {
		console.log(c.bold("Secret references"));
		for (const ref of report.secret_refs) {
			if (ref.status === "ready_local_env")
				console.log(`  ${c.green("✓")} ${ref.name}  ${c.dim("local env (uploads on deploy)")}`);
			else if (ref.status === "ready_org")
				console.log(`  ${c.green("✓")} ${ref.name}  ${c.dim("org store")}`);
			else
				console.log(
					`  ${c.red("✗")} ${ref.name}  ${c.dim(`not found — ${ref.fixes[0]?.command ?? ""}`)}`,
				);
		}
	}

	if (report.warnings?.length) {
		for (const warning of report.warnings) console.log(c.yellow(`Warning: ${warning}`));
	}
}

async function requireAgentReady(
	file: string,
	server: string,
	args: JsonArgs,
	secretOverrides: Record<string, string> = {},
): Promise<void> {
	let report: CapabilityDoctorReport;
	try {
		report = await buildCapabilityDoctorReport(file, server, secretOverrides);
	} catch (err) {
		if (wantsJson(args)) {
			console.log(
				JSON.stringify({
					schema_version: "parel.capability_doctor.v2",
					ok: false,
					agent_file: file,
					error: err instanceof Error ? err.message : String(err),
				}),
			);
			process.exit(err instanceof ApiError ? EXIT_API : EXIT_CLI);
		}
		handleError(err);
	}

	if (!report.ok) {
		renderDoctorReport(report, args);
		process.exit(EXIT_REQUIREMENTS);
	}
}

interface SessionMessagePart {
	type: string;
	text?: string;
	summary?: string;
	content?: string;
}

interface SessionMessage {
	role: string;
	content?: string;
	parts?: SessionMessagePart[];
}

function sessionMessageText(message: SessionMessage): string {
	if (typeof message.content === "string") return message.content;
	return (message.parts ?? [])
		.map((part) => {
			if (part.type === "text") return part.text ?? "";
			if (part.type === "reasoning") return part.summary ?? part.text ?? "";
			if (part.type === "tool_result") return part.content ?? "";
			return "";
		})
		.filter(Boolean)
		.join("");
}

function printSessionMessages(messages: SessionMessage[]): void {
	for (const message of messages) {
		const text = sessionMessageText(message);
		if (message.role === "user") console.log(`${c.cyan("$")} ${text}`);
		else if (message.role === "assistant") console.log(`${c.green("▸")} ${text}`);
		else console.log(`${c.dim(`[${message.role}]`)} ${text.slice(0, 200)}`);
		console.log();
	}
}

// ── WebSocket turn collector (used by send --wait and run) ─────────

interface TurnResult {
	session_id: string;
	status: "completed" | "error" | "timeout";
	response: string;
	messages: { role: string; content: string }[];
	tool_calls: { name: string; arguments: unknown }[];
	error?: string;
}

function collectTurn(
	wsUrl: string,
	sessionId: string,
	message: string,
	timeoutSec: number,
): Promise<TurnResult> {
	return new Promise((resolve) => {
		const token = resolveApiKey() ?? "";
		const request = sessionWebSocketRequest(wsUrl, sessionId, token);
		const ws = new WebSocket(request.url, request.protocols);
		let response = "";
		const messages: TurnResult["messages"] = [];
		const toolCalls: TurnResult["tool_calls"] = [];
		let resolved = false;

		const finish = (status: TurnResult["status"], error?: string) => {
			if (resolved) return;
			resolved = true;
			ws.close();
			resolve({ session_id: sessionId, status, response, messages, tool_calls: toolCalls, error });
		};

		const timer = setTimeout(
			() => finish("timeout", `No response within ${timeoutSec}s`),
			timeoutSec * 1000,
		);

		ws.addEventListener("open", () => {
			ws.send(JSON.stringify({ type: "message", content: message }));
		});

		ws.addEventListener("error", () => {
			clearTimeout(timer);
			finish("error", "WebSocket connection failed");
		});

		ws.addEventListener("close", () => {
			clearTimeout(timer);
			if (!resolved) finish("error", "WebSocket closed before turn_end");
		});

		ws.addEventListener("message", (ev) => {
			let event: { type: string; [k: string]: unknown };
			try {
				event = JSON.parse(String(ev.data));
			} catch {
				return;
			}

			switch (event.type) {
				case "text":
				case "message":
				case "content_block_delta":
				case "delta": {
					const chunk = (event.text ?? event.delta ?? event.content ?? "") as string;
					if (chunk) response += chunk;
					break;
				}
				case "tool_call": {
					toolCalls.push({
						name: (event.name ?? "unknown") as string,
						arguments: event.arguments ?? event.input ?? {},
					});
					break;
				}
				case "tool_result": {
					const content = JSON.stringify(event.result ?? event.output ?? event);
					messages.push({ role: "tool_result", content });
					break;
				}
				case "turn_end":
					clearTimeout(timer);
					if (response) messages.push({ role: "assistant", content: response });
					finish("completed");
					break;
				case "error":
					clearTimeout(timer);
					finish("error", (event.error ?? event.message ?? event.reason ?? "unknown") as string);
					break;
			}
		});
	});
}

// ── Commands: send (agent-first, non-interactive) ──────────────────

const send = defineCommand({
	meta: { name: "send", description: "Send a message, wait for result" },
	args: {
		agent: { type: "string", description: "Agent ID (auto-creates session)" },
		session: { type: "string", description: "Existing session ID" },
		message: { type: "string", alias: "m", description: "Message text" },
		stdin: { type: "boolean", description: "Read message from stdin" },
		async: { type: "boolean", description: "Fire-and-forget (don't wait for response)" },
		timeout: { type: "string", alias: "t", description: "Wait timeout in seconds", default: "120" },
		json: { type: "boolean", description: "JSON output" },
		server: { type: "string", description: "Server URL" },
	},
	async run({ args }) {
		requireAuth(args);
		const server = resolveServer(args);
		const json = args as { json?: boolean };

		// Resolve message
		let message = args.message;
		if (args.stdin) {
			message = await readStdin();
		}
		if (!message) fail("Provide --message or --stdin", EXIT_CLI);

		// Resolve session
		let sessionId = args.session;
		if (!sessionId) {
			if (!args.agent) fail("Provide --agent or --session", EXIT_CLI);
			try {
				const sess = await createSession(server, { agent: args.agent });
				sessionId = sess.id;
			} catch (err) {
				handleError(err);
			}
		}

		if (args.async) {
			try {
				const res = await apiFetch(server, `/sessions/${sessionId}/messages`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ content: message }),
				});
				const data = (await res.json()) as { status: string; workflowId: string };
				outputSuccess({ session_id: sessionId, ...data }, c.green(`Sent to ${sessionId}`), json);
			} catch (err) {
				handleError(err);
			}
			return;
		}

		// Wait mode: WebSocket, collect full response
		const wsUrl = server.replace("https://", "wss://").replace("http://", "ws://");
		const timeoutSec = parseInt(args.timeout, 10) || 120;
		const result = await collectTurn(wsUrl, sessionId, message, timeoutSec);

		if (result.status === "timeout") {
			if (wantsJson(json)) console.log(JSON.stringify(result));
			else console.error(c.yellow(`Timeout after ${timeoutSec}s. Session: ${sessionId}`));
			process.exit(EXIT_TIMEOUT);
		}
		if (result.status === "error") {
			if (wantsJson(json)) console.log(JSON.stringify(result));
			else console.error(c.red(`Error: ${result.error}`));
			process.exit(EXIT_API);
		}

		outputSuccess(result, result.response, json);
	},
});

// ── Commands: run (deploy + send in one shot) ──────────────────────

const run = defineCommand({
	meta: { name: "run", description: "Deploy + send + wait, all in one shot" },
	args: {
		file: { type: "positional", description: "Path to agent.yaml", required: true },
		message: { type: "string", alias: "m", description: "Message text" },
		stdin: { type: "boolean", description: "Read message from stdin" },
		timeout: { type: "string", alias: "t", description: "Wait timeout in seconds", default: "120" },
		"require-ready": { type: "boolean", description: "Run capability doctor before deploy" },
		secret: { type: "string", description: "Secret override NAME=value (repeatable)" },
		json: { type: "boolean", description: "JSON output" },
		server: { type: "string", description: "Server URL" },
	},
	async run({ args }) {
		requireAuth(args);
		const server = resolveServer(args);
		const json = args as { json?: boolean };

		if (!existsSync(args.file)) fail(`File not found: ${args.file}`, EXIT_CLI);
		// Parse inside the CLI error path: a malformed --secret must produce the
		// normal (and --json-aware) error output, not a citty stack trace.
		let secretOverrides: Record<string, string> = {};
		try {
			secretOverrides = parseSecretOverrides(args.secret);
		} catch (err) {
			handleError(err);
		}
		if (args["require-ready"]) await requireAgentReady(args.file, server, args, secretOverrides);

		let message = args.message;
		if (args.stdin) message = await readStdin();
		if (!message) fail("Provide --message or --stdin", EXIT_CLI);

		let agentId = "";
		try {
			const agent = await deployAgentVersion(server, args.file, json, secretOverrides, {
				activate: true,
			});
			agentId = agent.id;
		} catch (err) {
			handleError(err);
		}

		// Create session
		let sessionId = "";
		try {
			const sess = await createSession(server, { agent: agentId });
			sessionId = sess.id;
		} catch (err) {
			handleError(err);
		}

		// Send + wait
		const wsUrl = server.replace("https://", "wss://").replace("http://", "ws://");
		const timeoutSec = parseInt(args.timeout, 10) || 120;
		const result = await collectTurn(wsUrl, sessionId, message, timeoutSec);

		const fullResult = { agent_id: agentId, ...result };

		if (result.status === "timeout") {
			if (wantsJson(json)) console.log(JSON.stringify(fullResult));
			else console.error(c.yellow(`Timeout after ${timeoutSec}s. Session: ${sessionId}`));
			process.exit(EXIT_TIMEOUT);
		}
		if (result.status === "error") {
			if (wantsJson(json)) console.log(JSON.stringify(fullResult));
			else console.error(c.red(`Error: ${result.error}`));
			process.exit(EXIT_API);
		}

		outputSuccess(fullResult, result.response, json);
	},
});

// ── Commands: login ────────────────────────────────────────────────

const login = defineCommand({
	meta: { name: "login", description: "Authenticate with an API key" },
	args: {
		key: { type: "string", description: "API key (pk_...)" },
		server: { type: "string", description: "Server URL" },
		json: { type: "boolean", description: "JSON output" },
	},
	async run({ args }) {
		let key = args.key;

		if (!key && !process.stdin.isTTY) {
			key = (await readStdin()).trim();
		}
		if (!key && process.stdin.isTTY) {
			const rl = createInterface({ input: process.stdin, output: process.stdout });
			key = await new Promise<string>((resolve) => {
				rl.question("API key: ", (answer) => {
					rl.close();
					resolve(answer.trim());
				});
			});
		}
		if (!key?.startsWith("pk_")) fail("Invalid API key. Keys start with pk_", EXIT_CLI);

		const server = resolveServer(args);
		try {
			const res = await fetch(`${server}/agents`, { headers: { Authorization: `Bearer ${key}` } });
			if (!res.ok) {
				fail(res.status === 401 ? "Invalid API key." : `Server returned ${res.status}`, EXIT_API);
			}
		} catch {
			fail(`Cannot reach server: ${server}`, EXIT_API);
		}

		const cfg = loadConfig();
		cfg.apiKey = key;
		if (args.server) cfg.server = args.server;
		saveConfig(cfg);

		outputSuccess(
			{ server: cfg.server, key_prefix: `${key.slice(0, 7)}...${key.slice(-4)}` },
			`${c.green("Logged in.")} ${c.dim(`${cfg.server}  ${key.slice(0, 7)}...${key.slice(-4)}`)}`,
			args,
		);
	},
});

// ── Commands: whoami ───────────────────────────────────────────────

const whoami = defineCommand({
	meta: { name: "whoami", description: "Show authentication status" },
	args: { server: { type: "string" }, json: { type: "boolean" } },
	async run({ args }) {
		const key = resolveApiKey();
		if (!key) {
			outputSuccess({ authenticated: false }, c.dim("Not authenticated."), args);
			return;
		}
		const server = resolveServer(args);
		let status = "unknown";
		try {
			const res = await fetch(`${server}/agents`, { headers: { Authorization: `Bearer ${key}` } });
			status =
				res.status === 401 ? "invalid_key" : res.ok ? "authenticated" : `error_${res.status}`;
		} catch {
			status = "unreachable";
		}

		outputSuccess(
			{ server, key_prefix: `${key.slice(0, 7)}...${key.slice(-4)}`, status },
			`server: ${server}\nkey:    ${key.slice(0, 7)}...${key.slice(-4)}\nstatus: ${status === "authenticated" ? c.green(status) : c.red(status)}`,
			args,
		);
	},
});

// ── Commands: config ────────────────────────────────────────────────

const configSet = defineCommand({
	meta: { name: "set", description: "Set config values" },
	args: { server: { type: "string" }, key: { type: "string" }, json: { type: "boolean" } },
	run({ args }) {
		const cfg = loadConfig();
		if (args.server) cfg.server = args.server;
		if (args.key) cfg.apiKey = args.key;
		saveConfig(cfg);
		outputSuccess({ path: CONFIG_FILE }, c.green(`Config saved: ${CONFIG_FILE}`), args);
	},
});

const configShow = defineCommand({
	meta: { name: "show", description: "Show current config" },
	args: { json: { type: "boolean" } },
	run({ args }) {
		const cfg = loadConfig();
		const data = {
			server: cfg.server,
			api_key: cfg.apiKey ? `${cfg.apiKey.slice(0, 7)}...${cfg.apiKey.slice(-4)}` : null,
			path: CONFIG_FILE,
		};
		if (wantsJson(args)) {
			console.log(JSON.stringify(data));
			return;
		}
		console.log(`server: ${data.server}`);
		console.log(`apiKey: ${data.api_key ?? c.dim("(not set)")}`);
		console.log(`config: ${c.dim(data.path)}`);
	},
});

const config = defineCommand({
	meta: { name: "config", description: "Manage CLI configuration" },
	subCommands: { set: configSet, show: configShow },
});

// ── Commands: deploy ────────────────────────────────────────────────

const deploy = defineCommand({
	meta: { name: "deploy", description: "Deploy an agent from a YAML config" },
	args: {
		file: { type: "positional", description: "Path to agent.yaml", required: true },
		"no-activate": {
			type: "boolean",
			description: "Upload as a staged version without making it live; promote it later",
		},
		"require-ready": { type: "boolean", description: "Run capability doctor before deploy" },
		secret: {
			type: "string",
			description: "Secret override NAME=value (repeatable; default source is local env)",
		},
		json: { type: "boolean" },
		server: { type: "string" },
	},
	async run({ args }) {
		requireAuth(args);
		if (!existsSync(args.file)) fail(`File not found: ${args.file}`, EXIT_CLI);
		try {
			const secretOverrides = parseSecretOverrides(args.secret);
			if (args["require-ready"])
				await requireAgentReady(args.file, resolveServer(args), args, secretOverrides);
			const server = resolveServer(args);
			if (args["no-activate"]) {
				await deployStagedVersion(server, args.file, args, secretOverrides);
				return;
			}
			const agent = await deployAgentVersion(server, args.file, args, secretOverrides, {
				activate: true,
			});
			outputSuccess(
				agent,
				`${c.green(`Deployed: ${agent.name}`)}${agent.version ? c.dim(` v${agent.version}`) : ""}  ${c.dim(agent.id)}`,
				args,
			);
		} catch (err) {
			handleError(err);
		}
	},
});

// Deploy a new version via the resource-shaped endpoint (POST /agents/:name/versions):
// the name in the path addresses the agent (the path IS its identity), replacing the
// deprecated body-named POST /agents. `activate: false` stages the version
// (?activate=false) instead of flipping the live deployment; the server reads
// `activate` from the query when the body omits it, so the shared deploy-request
// builder (JSON or text/yaml body) is reused untouched.
async function deployAgentVersion(
	server: string,
	file: string,
	args: JsonArgs,
	secretOverrides: Record<string, string>,
	opts: { activate: boolean },
): Promise<Awaited<ReturnType<typeof deployAgentFile>>> {
	const name = readAgentName(file);
	if (!name) fail("Deploy needs `agent.name` in the config to address the version.", EXIT_CLI);
	const query = opts.activate ? "" : "?activate=false";
	return deployAgentFile(server, file, `/agents/${encodeURIComponent(name)}/versions${query}`, {
		args,
		secretOverrides,
	});
}

// `deploy --no-activate`: stage a new version without flipping the live deployment.
async function deployStagedVersion(
	server: string,
	file: string,
	args: JsonArgs,
	secretOverrides: Record<string, string>,
): Promise<void> {
	const agent = await deployAgentVersion(server, file, args, secretOverrides, { activate: false });
	const vLabel = agent.version ? `v${agent.version}` : "version";
	if (agent.active) {
		// A brand-new agent's first version is always live — staging it would leave
		// the agent with no runnable version, so the server activates it anyway.
		outputSuccess(
			agent,
			`${c.green(`Deployed: ${agent.name} ${vLabel}`)} ${c.dim("(first version is always live)")}  ${c.dim(agent.id)}`,
			args,
		);
		return;
	}
	outputSuccess(
		agent,
		`${c.green(`Staged: ${agent.name} ${vLabel}`)} ${c.dim("(not live)")}\n` +
			`  ${c.dim("try it:")}     parel try ${agent.name} --version ${vLabel} -m "..."\n` +
			`  ${c.dim("promote it:")} parel promote ${agent.name} --version ${vLabel}`,
		args,
	);
}

// ── Commands: agents ────────────────────────────────────────────────

const agentsList = defineCommand({
	meta: { name: "list", description: "List deployed agents" },
	args: { json: { type: "boolean" }, server: { type: "string" } },
	async run({ args }) {
		requireAuth(args);
		try {
			const res = await apiFetch(resolveServer(args), "/agents");
			const list = (await res.json()) as Record<string, unknown>[];
			if (wantsJson(args)) {
				console.log(JSON.stringify(list));
				return;
			}
			printTable(
				list.map((a) => ({
					id: a.id,
					name: a.name,
					model: `${a.provider ?? ""}/${a.model ?? ""}`,
					sessions: `${a.active_sessions}/${a.total_sessions}`,
					cost: `$${Number(a.total_cost ?? 0).toFixed(2)}`,
				})),
			);
		} catch (err) {
			handleError(err);
		}
	},
});

const agentsGet = defineCommand({
	meta: { name: "get", description: "Get agent details" },
	args: {
		id: { type: "positional", required: true },
		json: { type: "boolean" },
		server: { type: "string" },
	},
	async run({ args }) {
		requireAuth(args);
		try {
			const res = await apiFetch(resolveServer(args), `/agents/${args.id}`);
			output(await res.json(), args);
		} catch (err) {
			handleError(err);
		}
	},
});

const agentsUpdate = defineCommand({
	meta: { name: "update", description: "Update an agent's config" },
	args: {
		id: { type: "positional", required: true },
		file: { type: "string", required: true },
		secret: {
			type: "string",
			description: "Secret override NAME=value (repeatable; default source is local env)",
		},
		json: { type: "boolean" },
		server: { type: "string" },
	},
	async run({ args }) {
		requireAuth(args);
		if (!existsSync(args.file)) fail(`File not found: ${args.file}`, EXIT_CLI);
		try {
			const server = resolveServer(args);
			const agent = await deployAgentFile(
				server,
				args.file,
				`/agents/${encodeURIComponent(args.id)}/versions`,
				{ args, secretOverrides: parseSecretOverrides(args.secret) },
			);
			outputSuccess(
				agent,
				c.green(`Updated: ${agent.name}${agent.version ? ` v${agent.version}` : ""} (${agent.id})`),
				args,
			);
		} catch (err) {
			handleError(err);
		}
	},
});

const agentsDelete = defineCommand({
	meta: { name: "delete", description: "Delete an agent" },
	args: {
		id: { type: "positional", required: true },
		json: { type: "boolean" },
		server: { type: "string" },
	},
	async run({ args }) {
		requireAuth(args);
		try {
			await apiFetch(resolveServer(args), `/agents/${args.id}`, { method: "DELETE" });
			outputSuccess({ deleted: true, id: args.id }, c.green(`Deleted: ${args.id}`), args);
		} catch (err) {
			handleError(err);
		}
	},
});

const agentsRename = defineCommand({
	meta: { name: "rename", description: "Rename an agent (keeps its id, versions and sessions)" },
	args: {
		agent: { type: "positional", description: "Current agent name or id", required: true },
		newName: { type: "positional", description: "New name", required: true },
		json: { type: "boolean" },
		server: { type: "string" },
	},
	async run({ args }) {
		requireAuth(args);
		try {
			const res = await apiFetch(
				resolveServer(args),
				`/agents/${encodeURIComponent(args.agent)}/rename`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ name: args.newName }),
				},
			);
			const data = (await res.json()) as { id: string; name: string };
			outputSuccess(data, c.green(`Renamed to ${data.name} (${data.id})`), args);
		} catch (err) {
			handleError(err);
		}
	},
});

const agents = defineCommand({
	meta: { name: "agents", description: "Agent management" },
	subCommands: {
		list: agentsList,
		get: agentsGet,
		update: agentsUpdate,
		rename: agentsRename,
		delete: agentsDelete,
	},
});

// ── Commands: versions / deployments / rollback ─────────────────────

const versionsList = defineCommand({
	meta: { name: "list", description: "List an agent's versions" },
	args: {
		agent: { type: "positional", description: "Agent name or id", required: true },
		json: { type: "boolean" },
		server: { type: "string" },
	},
	async run({ args }) {
		requireAuth(args);
		try {
			const res = await apiFetch(
				resolveServer(args),
				`/agents/${encodeURIComponent(args.agent)}/versions`,
			);
			const list = (await res.json()) as Record<string, unknown>[];
			if (wantsJson(args)) {
				console.log(JSON.stringify(list));
				return;
			}
			printTable(
				list.map((v) => ({
					version: `v${v.number}${v.active ? c.green(" *") : ""}`,
					created: v.created_at,
					message: v.message ?? "",
				})),
			);
		} catch (err) {
			handleError(err);
		}
	},
});

const versions = defineCommand({
	meta: { name: "versions", description: "Agent version history" },
	subCommands: { list: versionsList },
});

const deploymentsList = defineCommand({
	meta: { name: "list", description: "List an agent's deployment timeline" },
	args: {
		agent: { type: "positional", description: "Agent name or id", required: true },
		json: { type: "boolean" },
		server: { type: "string" },
	},
	async run({ args }) {
		requireAuth(args);
		try {
			const res = await apiFetch(
				resolveServer(args),
				`/agents/${encodeURIComponent(args.agent)}/deployments`,
			);
			const list = (await res.json()) as Record<string, unknown>[];
			if (wantsJson(args)) {
				console.log(JSON.stringify(list));
				return;
			}
			printTable(
				list.map((d) => ({
					when: d.created_at,
					kind: d.kind,
					version: d.version_number != null ? `v${d.version_number}` : c.dim(String(d.version_id)),
				})),
			);
		} catch (err) {
			handleError(err);
		}
	},
});

const deployments = defineCommand({
	meta: { name: "deployments", description: "Agent deployment timeline" },
	subCommands: { list: deploymentsList },
});

const rollback = defineCommand({
	meta: {
		name: "rollback",
		description: "Roll back to a previous version (equivalent to `promote` of an older version)",
	},
	args: {
		agent: { type: "positional", description: "Agent name or id", required: true },
		to: {
			type: "string",
			description: "Target version (e.g. v3 or 3); default = the previously live version",
		},
		json: { type: "boolean" },
		server: { type: "string" },
	},
	async run({ args }) {
		requireAuth(args);
		try {
			// Match the API contract: a version number (`3`/`v3`) is sent as a number;
			// anything else (a version id) is sent as-is. citty leaves --to a string.
			let to: number | string | undefined;
			if (args.to != null) {
				const m = String(args.to).match(/^v?(\d+)$/i);
				to = m ? Number(m[1]) : args.to;
			}
			const res = await apiFetch(
				resolveServer(args),
				`/agents/${encodeURIComponent(args.agent)}/rollback`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(to !== undefined ? { to } : {}),
				},
			);
			const data = (await res.json()) as { id: string; name: string; version: number };
			outputSuccess(data, c.green(`Rolled back ${data.name} to v${data.version}`), args);
		} catch (err) {
			handleError(err);
		}
	},
});

const promote = defineCommand({
	meta: {
		name: "promote",
		description: "Make a version the live deployment (promote forward or roll back)",
	},
	args: {
		agent: { type: "positional", description: "Agent name or id", required: true },
		version: {
			type: "string",
			description: "Version to make live (e.g. v3, 3, or a version id)",
			required: true,
		},
		json: { type: "boolean" },
		server: { type: "string" },
	},
	async run({ args }) {
		requireAuth(args);
		try {
			const res = await apiFetch(
				resolveServer(args),
				`/agents/${encodeURIComponent(args.agent)}/deployments`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ version: args.version }),
				},
			);
			const data = (await res.json()) as { id: string; name: string; version: number };
			outputSuccess(data, c.green(`Promoted ${data.name} to v${data.version} (live)`), args);
		} catch (err) {
			handleError(err);
		}
	},
});

// ── Commands: try (throwaway ephemeral run) ─────────────────────────

const tryRun = defineCommand({
	meta: {
		name: "try",
		description: "Run one throwaway (ephemeral) turn — optionally against a specific version",
	},
	args: {
		agent: { type: "positional", description: "Agent name or id", required: true },
		version: {
			type: "string",
			description: "Try a specific version (e.g. v3); implies an ephemeral run",
		},
		message: { type: "string", alias: "m", description: "Message text (required)" },
		timeout: { type: "string", alias: "t", description: "Wait timeout in seconds", default: "120" },
		json: { type: "boolean" },
		server: { type: "string" },
	},
	async run({ args }) {
		requireAuth(args);
		const server = resolveServer(args);
		const json = args as { json?: boolean };
		// `try` is a single non-interactive turn; interactive use is `parel chat`.
		if (!args.message)
			fail("Provide --message/-m. For an interactive session use `parel chat`.", EXIT_CLI);

		// Ephemeral session: a version pin forces ephemeral server-side; without a
		// version we ask for ephemeral explicitly so the run leaves no named entity.
		let sessionId = "";
		try {
			const res = await apiFetch(server, "/sessions", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					agent: args.agent,
					...(args.version ? { version: args.version } : { ephemeral: true }),
				}),
			});
			sessionId = ((await res.json()) as { id: string }).id;
		} catch (err) {
			handleError(err);
		}

		const wsUrl = server.replace("https://", "wss://").replace("http://", "ws://");
		const timeoutSec = parseInt(args.timeout, 10) || 120;
		const result = await collectTurn(wsUrl, sessionId, args.message, timeoutSec);

		if (result.status === "timeout") {
			if (wantsJson(json)) console.log(JSON.stringify(result));
			else console.error(c.yellow(`Timeout after ${timeoutSec}s. Session: ${sessionId}`));
			process.exit(EXIT_TIMEOUT);
		}
		if (result.status === "error") {
			if (wantsJson(json)) console.log(JSON.stringify(result));
			else console.error(c.red(`Error: ${result.error}`));
			process.exit(EXIT_API);
		}

		outputSuccess(result, result.response, json);
	},
});

// ── Commands: instances ─────────────────────────────────────────────

const instancesList = defineCommand({
	meta: { name: "list", description: "List an agent's instances" },
	args: {
		agent: { type: "positional", description: "Agent name or id", required: true },
		json: { type: "boolean" },
		server: { type: "string" },
	},
	async run({ args }) {
		requireAuth(args);
		try {
			const server = resolveServer(args);
			const res = await apiFetch(server, `/agents/${encodeURIComponent(args.agent)}/instances`);
			const list = (await res.json()) as Record<string, unknown>[];
			if (wantsJson(args)) {
				console.log(JSON.stringify(list));
				return;
			}
			// The instances API carries only the pinned version id; resolve ids to
			// friendly `vN` labels via /versions, but only when something is pinned.
			// Best-effort: a /versions hiccup falls back to showing the raw id.
			let numberByVersionId: Map<string, number> | undefined;
			if (list.some((i) => i.tracking === "pinned" && i.pinned_version_id)) {
				try {
					const vres = await apiFetch(server, `/agents/${encodeURIComponent(args.agent)}/versions`);
					const versions = (await vres.json()) as Array<{ id: string; number: number }>;
					numberByVersionId = new Map(versions.map((v) => [v.id, v.number]));
				} catch {}
			}
			printTable(
				list.map((i) => {
					const pinnedId = (i.pinned_version_id as string | null) ?? null;
					const num = pinnedId ? numberByVersionId?.get(pinnedId) : undefined;
					const pinned =
						i.tracking !== "pinned" ? c.dim("—") : num != null ? `v${num}` : (pinnedId ?? "");
					return { key: i.key, tracking: i.tracking, pinned, sessions: i.session_count ?? 0 };
				}),
			);
		} catch (err) {
			handleError(err);
		}
	},
});

const instancesPin = defineCommand({
	meta: { name: "pin", description: "Pin an instance to a specific version" },
	args: {
		agent: { type: "positional", description: "Agent name or id", required: true },
		key: { type: "positional", description: "Instance key", required: true },
		version: {
			type: "string",
			description: "Version to pin (e.g. v3, 3, or a version id)",
			required: true,
		},
		json: { type: "boolean" },
		server: { type: "string" },
	},
	async run({ args }) {
		requireAuth(args);
		try {
			const res = await apiFetch(
				resolveServer(args),
				`/agents/${encodeURIComponent(args.agent)}/instances/${encodeURIComponent(args.key)}`,
				{
					method: "PATCH",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ tracking: "pinned", version: args.version }),
				},
			);
			const data = (await res.json()) as { key: string; pinned_version_id: string | null };
			// Echo the version the user asked for (e.g. `v3`); the response only
			// carries the resolved version id.
			outputSuccess(data, c.green(`Pinned ${data.key} → ${args.version}`), args);
		} catch (err) {
			handleError(err);
		}
	},
});

const instancesVars = defineCommand({
	meta: {
		name: "vars",
		description: "Set an instance's ${var:NAME} values (full replacement)",
	},
	args: {
		agent: { type: "positional", description: "Agent name or id", required: true },
		key: { type: "positional", description: "Instance key", required: true },
		set: {
			type: "string",
			description: "NAME=value pair (repeatable); omit all pairs to clear vars",
		},
		json: { type: "boolean" },
		server: { type: "string" },
	},
	async run({ args }) {
		requireAuth(args);
		// citty collects repeated flags into an array; a single flag arrives as a string.
		const pairs = Array.isArray(args.set) ? args.set : args.set ? [args.set] : [];
		const vars: Record<string, string> = {};
		for (const pair of pairs) {
			const eq = pair.indexOf("=");
			if (eq <= 0) {
				handleError(new Error(`--set expects NAME=value, got: ${pair}`));
				return;
			}
			vars[pair.slice(0, eq)] = pair.slice(eq + 1);
		}
		try {
			const res = await apiFetch(
				resolveServer(args),
				`/agents/${encodeURIComponent(args.agent)}/instances/${encodeURIComponent(args.key)}`,
				{
					method: "PATCH",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ vars }),
				},
			);
			const data = (await res.json()) as { key: string };
			const names = Object.keys(vars);
			outputSuccess(
				data,
				c.green(
					names.length
						? `Set ${names.length} var${names.length > 1 ? "s" : ""} on ${data.key}: ${names.join(", ")}`
						: `Cleared vars on ${data.key}`,
				),
				args,
			);
		} catch (err) {
			handleError(err);
		}
	},
});

const instancesUnpin = defineCommand({
	meta: { name: "unpin", description: "Return an instance to tracking the live deployment" },
	args: {
		agent: { type: "positional", description: "Agent name or id", required: true },
		key: { type: "positional", description: "Instance key", required: true },
		json: { type: "boolean" },
		server: { type: "string" },
	},
	async run({ args }) {
		requireAuth(args);
		try {
			const res = await apiFetch(
				resolveServer(args),
				`/agents/${encodeURIComponent(args.agent)}/instances/${encodeURIComponent(args.key)}`,
				{
					method: "PATCH",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ tracking: "live" }),
				},
			);
			const data = (await res.json()) as { key: string };
			outputSuccess(data, c.green(`Unpinned ${data.key} (now tracking live)`), args);
		} catch (err) {
			handleError(err);
		}
	},
});

const instancesReset = defineCommand({
	meta: {
		name: "reset",
		description: "Wipe an instance's entity state (sandbox, memory); keeps its sessions",
	},
	args: {
		agent: { type: "positional", description: "Agent name or id", required: true },
		key: { type: "positional", description: "Instance key", required: true },
		json: { type: "boolean" },
		server: { type: "string" },
	},
	async run({ args }) {
		requireAuth(args);
		try {
			const res = await apiFetch(
				resolveServer(args),
				`/agents/${encodeURIComponent(args.agent)}/instances/${encodeURIComponent(args.key)}/reset`,
				{ method: "POST" },
			);
			const data = (await res.json()) as { key: string };
			outputSuccess(data, c.green(`Reset ${data.key}`), args);
		} catch (err) {
			handleError(err);
		}
	},
});

const instancesDelete = defineCommand({
	meta: { name: "delete", description: "Delete an instance and purge its entity state" },
	args: {
		agent: { type: "positional", description: "Agent name or id", required: true },
		key: { type: "positional", description: "Instance key", required: true },
		json: { type: "boolean" },
		server: { type: "string" },
	},
	async run({ args }) {
		requireAuth(args);
		try {
			await apiFetch(
				resolveServer(args),
				`/agents/${encodeURIComponent(args.agent)}/instances/${encodeURIComponent(args.key)}`,
				{ method: "DELETE" },
			);
			outputSuccess(
				{ deleted: true, key: args.key },
				c.green(`Deleted instance ${args.key}`),
				args,
			);
		} catch (err) {
			// A 409 means live sessions still hold the instance; point at the fix
			// instead of surfacing a bare conflict (human mode only — JSON keeps the
			// clean server message for scripts).
			if (err instanceof ApiError && err.status === 409 && !wantsJson(args)) {
				fail(
					`${err.message}\n  ${c.dim(`List them: parel sessions list --agent ${args.agent}`)}`,
					EXIT_API,
				);
			}
			handleError(err);
		}
	},
});

const instances = defineCommand({
	meta: { name: "instances", description: "Agent instance management" },
	subCommands: {
		list: instancesList,
		pin: instancesPin,
		vars: instancesVars,
		unpin: instancesUnpin,
		reset: instancesReset,
		delete: instancesDelete,
	},
});

// ── Commands: sessions ──────────────────────────────────────────────

const sessionsList = defineCommand({
	meta: { name: "list", description: "List sessions" },
	args: {
		agent: { type: "string" },
		status: { type: "string" },
		limit: { type: "string", default: "20" },
		json: { type: "boolean" },
		server: { type: "string" },
	},
	async run({ args }) {
		requireAuth(args);
		const params = new URLSearchParams();
		if (args.agent) params.set("agent_id", args.agent);
		if (args.status) params.set("status", args.status);
		params.set("limit", args.limit);
		const qs = params.toString();
		try {
			const res = await apiFetch(resolveServer(args), `/sessions${qs ? `?${qs}` : ""}`);
			const list = (await res.json()) as Record<string, unknown>[];
			if (wantsJson(args)) {
				console.log(JSON.stringify(list));
				return;
			}
			printTable(
				list.map((s) => ({
					id: s.id,
					agent: s.agent_name ?? s.agent_id,
					status: s.status,
					steps: s.step_count,
					tokens: s.total_tokens,
					cost: `$${Number(s.total_cost_usd ?? 0).toFixed(3)}`,
				})),
			);
		} catch (err) {
			handleError(err);
		}
	},
});

const sessionsGet = defineCommand({
	meta: { name: "get", description: "Get session state" },
	args: {
		id: { type: "positional", required: true },
		json: { type: "boolean" },
		server: { type: "string" },
	},
	async run({ args }) {
		requireAuth(args);
		try {
			const res = await apiFetch(resolveServer(args), `/sessions/${args.id}`);
			output(await res.json(), args);
		} catch (err) {
			handleError(err);
		}
	},
});

const sessionsMessages = defineCommand({
	meta: { name: "messages", description: "Show session messages" },
	args: {
		id: { type: "positional", required: true },
		json: { type: "boolean" },
		server: { type: "string" },
	},
	async run({ args }) {
		requireAuth(args);
		try {
			const res = await apiFetch(resolveServer(args), `/sessions/${args.id}/messages?view=chat`);
			const msgs = (await res.json()) as SessionMessage[];
			if (wantsJson(args)) {
				console.log(JSON.stringify(msgs));
				return;
			}
			printSessionMessages(msgs);
		} catch (err) {
			handleError(err);
		}
	},
});

const sessionsCreate = defineCommand({
	meta: { name: "create", description: "Create a new session" },
	args: {
		agent: { type: "positional", required: true },
		instance: { type: "string", description: "Target a named instance (default: main)" },
		json: { type: "boolean" },
		server: { type: "string" },
	},
	async run({ args }) {
		requireAuth(args);
		try {
			const server = resolveServer(args);
			const session = await createSession(server, {
				agent: args.agent,
				...(args.instance ? { instance: args.instance } : {}),
			});
			outputSuccess(
				session,
				`${c.green(`Session: ${session.id}`)}  ${c.dim(session.status)}${session.instance ? c.dim(` @${session.instance}`) : ""}`,
				args,
			);
		} catch (err) {
			handleError(err);
		}
	},
});

const sessions = defineCommand({
	meta: { name: "sessions", description: "Session management" },
	subCommands: {
		list: sessionsList,
		get: sessionsGet,
		create: sessionsCreate,
		messages: sessionsMessages,
	},
});

// ── Commands: chat (interactive, for humans) ────────────────────────

const chat = defineCommand({
	meta: { name: "chat", description: "Interactive chat REPL (for humans)" },
	args: {
		agent: { type: "string", description: "Agent ID (creates new session)" },
		session: { type: "string", description: "Resume existing session" },
		server: { type: "string" },
	},
	async run({ args }) {
		requireAuth(args);
		const server = resolveServer(args);
		let sessionId = args.session;

		if (!sessionId) {
			if (!args.agent) fail("Provide --agent or --session", EXIT_CLI);
			try {
				sessionId = (await createSession(server, { agent: args.agent })).id;
			} catch (err) {
				handleError(err);
			}
		}

		console.log(`\n${c.bold("  PAREL Chat")}`);
		console.log(c.dim(`  session: ${sessionId}`));
		console.log(c.dim("  /quit to exit, /messages for log\n"));

		const wsUrl = server.replace("https://", "wss://").replace("http://", "ws://");
		let ws: WebSocket;
		let busy = false;
		let hasOutput = false;
		let turnTimer: ReturnType<typeof setTimeout> | null = null;

		const resetTimer = () => {
			if (turnTimer) clearTimeout(turnTimer);
			turnTimer = setTimeout(() => {
				if (busy) {
					busy = false;
					hasOutput = false;
					process.stdout.write("\n");
					rl.prompt();
				}
			}, 60_000);
		};
		const clearTimer = () => {
			if (turnTimer) {
				clearTimeout(turnTimer);
				turnTimer = null;
			}
		};

		const rl = createInterface({
			input: process.stdin,
			output: process.stdout,
			prompt: `${isColor ? "\x1b[36m" : ""}$ ${isColor ? "\x1b[0m" : ""}`,
		});

		function connect(): Promise<void> {
			return new Promise((resolve, reject) => {
				const token = resolveApiKey() ?? "";
				const request = sessionWebSocketRequest(wsUrl, sessionId, token);
				ws = new WebSocket(request.url, request.protocols);
				ws.addEventListener("open", () => resolve());
				ws.addEventListener("error", () => {
					if (!busy) reject(new Error("WebSocket connection failed"));
				});
				ws.addEventListener("close", () => {
					if (busy) {
						busy = false;
						hasOutput = false;
						process.stdout.write("\n");
						rl.prompt();
					}
				});
				ws.addEventListener("message", (ev) => {
					if (busy) resetTimer();
					let event: { type: string; [k: string]: unknown };
					try {
						event = JSON.parse(String(ev.data));
					} catch {
						return;
					}
					switch (event.type) {
						case "text":
						case "message":
						case "content_block_delta":
						case "delta": {
							const chunk = (event.text ?? event.delta ?? event.content ?? "") as string;
							if (!chunk) break;
							if (!hasOutput) {
								hasOutput = true;
								process.stdout.write(c.green("▸ "));
							}
							process.stdout.write(chunk);
							break;
						}
						case "tool_call": {
							if (!hasOutput) hasOutput = true;
							const name = (event.name ?? "tool") as string;
							process.stdout.write(
								`\n${c.dim(`  [tool] ${name}(${JSON.stringify(event.arguments ?? event.input ?? {}).slice(0, 100)})`)}`,
							);
							break;
						}
						case "tool_result":
							process.stdout.write(
								`\n${c.dim(`  [result] ${JSON.stringify(event.result ?? event.output ?? event).slice(0, 100)}`)}`,
							);
							break;
						case "turn_end":
							clearTimer();
							busy = false;
							hasOutput = false;
							process.stdout.write("\n\n");
							rl.prompt();
							break;
						case "error":
							clearTimer();
							console.error(
								`\n${c.red(`Error: ${(event.error ?? event.message ?? event.reason ?? "unknown") as string}`)}`,
							);
							busy = false;
							hasOutput = false;
							rl.prompt();
							break;
					}
				});
			});
		}

		try {
			await connect();
		} catch (err) {
			handleError(err);
		}

		rl.on("line", async (line) => {
			const input = line.trim();
			if (!input) {
				rl.prompt();
				return;
			}
			if (input === "/quit" || input === "/exit") {
				ws.close();
				rl.close();
				console.log(c.dim("\n  Session ended.\n"));
				process.exit(0);
			}
			if (input === "/messages") {
				try {
					const res = await apiFetch(server, `/sessions/${sessionId}/messages?view=chat`);
					const msgs = (await res.json()) as SessionMessage[];
					console.log();
					printSessionMessages(msgs);
				} catch (err) {
					console.error(c.red(err instanceof Error ? err.message : String(err)));
				}
				rl.prompt();
				return;
			}
			if (busy) return;
			busy = true;
			hasOutput = false;
			if (ws.readyState !== WebSocket.OPEN) {
				console.log(c.yellow("Reconnecting..."));
				try {
					await connect();
				} catch (err) {
					console.error(c.red(err instanceof Error ? err.message : String(err)));
					busy = false;
					rl.prompt();
					return;
				}
			}
			ws.send(JSON.stringify({ type: "message", content: input }));
			resetTimer();
		});

		rl.on("close", () => {
			clearTimer();
			ws.close();
			process.exit(0);
		});
		rl.prompt();
	},
});

// ── Commands: logs ──────────────────────────────────────────────────

const logs = defineCommand({
	meta: { name: "logs", description: "Show session events and logs" },
	args: {
		session: { type: "positional", required: true },
		json: { type: "boolean" },
		server: { type: "string" },
	},
	async run({ args }) {
		requireAuth(args);
		try {
			const [eventsRes, logsRes] = await Promise.all([
				apiFetch(resolveServer(args), `/sessions/${args.session}/events`),
				apiFetch(resolveServer(args), `/sessions/${args.session}/logs`),
			]);
			const events = (await eventsRes.json()) as Record<string, unknown>[];
			const logEntries = (await logsRes.json()) as Record<string, unknown>[];
			if (wantsJson(args)) {
				console.log(JSON.stringify({ events, logs: logEntries }));
				return;
			}
			if (events.length > 0) {
				console.log(c.bold("Events"));
				for (const e of events) {
					const ts = c.dim(String(e.created_at ?? "").slice(11, 19));
					const data = typeof e.data === "string" ? e.data : JSON.stringify(e.data);
					console.log(`  ${ts}  ${c.dim(`[${e.seq}]`)} ${e.type}  ${String(data).slice(0, 80)}`);
				}
			}
			if (logEntries.length > 0) {
				console.log(c.bold("\nLogs"));
				for (const l of logEntries) {
					const ts = c.dim(String(l.created_at ?? "").slice(11, 19));
					const data = typeof l.data === "string" ? l.data : JSON.stringify(l.data);
					console.log(`  ${ts}  ${l.type}  ${String(data).slice(0, 100)}`);
				}
			}
			if (events.length === 0 && logEntries.length === 0) console.log(c.dim("No events or logs."));
		} catch (err) {
			handleError(err);
		}
	},
});

// ── Commands: steer ─────────────────────────────────────────────────

const steer = defineCommand({
	meta: { name: "steer", description: "Steer a running session" },
	args: {
		session: { type: "string", required: true },
		message: { type: "positional", required: true },
		json: { type: "boolean" },
		server: { type: "string" },
	},
	async run({ args }) {
		requireAuth(args);
		try {
			await apiFetch(resolveServer(args), `/sessions/${args.session}/steer`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ content: args.message }),
			});
			outputSuccess({ accepted: true }, c.green("Steer accepted."), args);
		} catch (err) {
			handleError(err);
		}
	},
});

// ── Commands: api-keys ──────────────────────────────────────────────

const apiKeysList = defineCommand({
	meta: { name: "list", description: "List API keys" },
	args: { json: { type: "boolean" }, server: { type: "string" } },
	async run({ args }) {
		requireAuth(args);
		try {
			const res = await apiFetch(resolveServer(args), "/api-keys");
			const list = (await res.json()) as Record<string, unknown>[];
			if (wantsJson(args)) {
				console.log(JSON.stringify(list));
				return;
			}
			printTable(
				list.map((k) => ({
					id: k.id,
					name: k.name,
					prefix: k.key_prefix,
					created: String(k.created_at ?? "").slice(0, 10),
					last_used: String(k.last_used_at ?? "never").slice(0, 10),
				})),
			);
		} catch (err) {
			handleError(err);
		}
	},
});

const apiKeysCreate = defineCommand({
	meta: { name: "create", description: "Create a new API key" },
	args: {
		name: { type: "positional", required: true },
		json: { type: "boolean" },
		server: { type: "string" },
	},
	async run({ args }) {
		requireAuth(args);
		try {
			const res = await apiFetch(resolveServer(args), "/api-keys", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name: args.name }),
			});
			const key = (await res.json()) as {
				id: string;
				name: string;
				key: string;
				key_prefix: string;
			};
			if (wantsJson(args)) {
				console.log(JSON.stringify(key));
				return;
			}
			console.log(c.green(`Created: ${key.name}`));
			console.log(`\n  ${c.bold(key.key)}\n`);
			console.log(c.yellow("  Save this key — it won't be shown again."));
		} catch (err) {
			handleError(err);
		}
	},
});

const apiKeysDelete = defineCommand({
	meta: { name: "delete", description: "Delete an API key" },
	args: {
		id: { type: "positional", required: true },
		json: { type: "boolean" },
		server: { type: "string" },
	},
	async run({ args }) {
		requireAuth(args);
		try {
			await apiFetch(resolveServer(args), `/api-keys/${args.id}`, { method: "DELETE" });
			outputSuccess({ deleted: true, id: args.id }, c.green(`Deleted: ${args.id}`), args);
		} catch (err) {
			handleError(err);
		}
	},
});

const apiKeys = defineCommand({
	meta: { name: "api-keys", description: "API key management" },
	subCommands: { list: apiKeysList, create: apiKeysCreate, delete: apiKeysDelete },
});

// ── Commands: provider-keys ────────────────────────────────────────

const providerKeysList = defineCommand({
	meta: { name: "list", description: "List model provider keys" },
	args: { json: { type: "boolean" }, server: { type: "string" } },
	async run({ args }) {
		requireAuth(args);
		try {
			const list = await listProviderKeys(resolveServer(args));
			if (wantsJson(args)) {
				console.log(JSON.stringify(list));
				return;
			}
			printTable(
				list.map((key) => ({
					id: key.id,
					provider: key.provider,
					prefix: key.key_prefix,
					created: String(key.created_at ?? "").slice(0, 10),
				})),
			);
		} catch (err) {
			handleError(err);
		}
	},
});

const providerKeysSet = defineCommand({
	meta: { name: "set", description: "Set a model provider key" },
	args: {
		provider: { type: "positional", required: true },
		"from-env": { type: "string", description: "Read the key from an environment variable" },
		stdin: { type: "boolean", description: "Read the key from stdin" },
		json: { type: "boolean" },
		server: { type: "string" },
	},
	async run({ args }) {
		requireAuth(args);
		try {
			const secret = await readSecretValue({ fromEnv: args["from-env"], stdin: args.stdin });
			const res = await apiFetch(resolveServer(args), "/provider-keys", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ provider: args.provider, key: secret.value }),
			});
			const data = (await res.json()) as { id: string; provider: string; key_prefix: string };
			outputSuccess(
				{ ...data, source: secret.source },
				`${c.green(`Set provider key: ${data.provider}`)}  ${c.dim(data.key_prefix)}`,
				args,
			);
		} catch (err) {
			handleError(err);
		}
	},
});

const providerKeysUnset = defineCommand({
	meta: { name: "unset", description: "Unset a model provider key by provider or id" },
	args: {
		target: { type: "positional", required: true },
		json: { type: "boolean" },
		server: { type: "string" },
	},
	async run({ args }) {
		requireAuth(args);
		try {
			const list = await listProviderKeys(resolveServer(args));
			const row = list.find((key) => key.id === args.target || key.provider === args.target);
			if (!row) fail(`Provider key not found: ${args.target}`, EXIT_CLI);
			await apiFetch(resolveServer(args), `/provider-keys/${row.id}`, { method: "DELETE" });
			outputSuccess(
				{ deleted: true, id: row.id, provider: row.provider },
				c.green(`Unset: ${row.provider}`),
				args,
			);
		} catch (err) {
			handleError(err);
		}
	},
});

const providerKeysDelete = defineCommand({
	meta: { name: "delete", description: "Delete a model provider key by id" },
	args: {
		id: { type: "positional", required: true },
		json: { type: "boolean" },
		server: { type: "string" },
	},
	async run({ args }) {
		requireAuth(args);
		try {
			await apiFetch(resolveServer(args), `/provider-keys/${args.id}`, { method: "DELETE" });
			outputSuccess({ deleted: true, id: args.id }, c.green(`Deleted: ${args.id}`), args);
		} catch (err) {
			handleError(err);
		}
	},
});

const providerKeys = defineCommand({
	meta: { name: "provider-keys", description: "Model provider credential management" },
	subCommands: {
		list: providerKeysList,
		set: providerKeysSet,
		unset: providerKeysUnset,
		delete: providerKeysDelete,
	},
});

// ── Commands: secrets ──────────────────────────────────────────────
// Named secrets referenced from agent.yaml as `${NAME}`. Org-scoped by
// default; `--agent <id>` scopes a value to one agent (overrides org).

const secretsList = defineCommand({
	meta: { name: "list", description: "List secrets (values never leave the server)" },
	args: { json: { type: "boolean" }, server: { type: "string" } },
	async run({ args }) {
		requireAuth(args);
		try {
			const list = await listSecrets(resolveServer(args));
			if (wantsJson(args)) {
				console.log(JSON.stringify(list));
				return;
			}
			printTable(
				list.map((secret) => ({
					name: secret.name,
					scope: secret.agent_id ? `agent:${secret.agent_id}` : "org",
					prefix: secret.value_prefix,
					updated: String(secret.updated_at ?? secret.created_at ?? "").slice(0, 10),
				})),
			);
		} catch (err) {
			handleError(err);
		}
	},
});

const secretsSet = defineCommand({
	meta: { name: "set", description: "Set a secret (reads the same-named env var by default)" },
	args: {
		name: { type: "positional", required: true, description: "Secret name, e.g. E2B_API_KEY" },
		agent: { type: "string", description: "Scope the value to one agent id" },
		"from-env": { type: "string", description: "Read the value from a different env var" },
		stdin: { type: "boolean", description: "Read the value from stdin" },
		json: { type: "boolean" },
		server: { type: "string" },
	},
	async run({ args }) {
		requireAuth(args);
		assertSecretName(args.name);
		try {
			const secret = await readSecretValue({
				fromEnv: args.stdin ? undefined : (args["from-env"] ?? args.name),
				stdin: args.stdin,
			});
			const res = await apiFetch(resolveServer(args), "/secrets", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					name: args.name,
					value: secret.value,
					...(args.agent ? { agentId: args.agent } : {}),
				}),
			});
			const data = (await res.json()) as {
				id: string;
				name: string;
				agent_id: string;
				value_prefix: string;
			};
			const scope = data.agent_id ? `agent:${data.agent_id}` : "org";
			outputSuccess(
				{ ...data, source: secret.source },
				`${c.green(`Set secret: ${data.name}`)}  ${c.dim(`${scope} (${data.value_prefix})`)}`,
				args,
			);
		} catch (err) {
			handleError(err);
		}
	},
});

const secretsUnset = defineCommand({
	meta: { name: "unset", description: "Remove a secret by name" },
	args: {
		name: { type: "positional", required: true },
		agent: { type: "string", description: "Remove the agent-scoped value instead of the org one" },
		json: { type: "boolean" },
		server: { type: "string" },
	},
	async run({ args }) {
		requireAuth(args);
		try {
			const list = await listSecrets(resolveServer(args));
			const agentId = args.agent ?? "";
			const row = list.find((secret) => secret.name === args.name && secret.agent_id === agentId);
			if (!row) {
				const scope = agentId ? `agent:${agentId}` : "org";
				fail(`Secret not found: ${args.name} (${scope})`, EXIT_CLI);
			}
			await apiFetch(resolveServer(args), `/secrets/${row.id}`, { method: "DELETE" });
			outputSuccess(
				{ deleted: true, id: row.id, name: row.name, agent_id: row.agent_id },
				c.green(`Unset: ${row.name}`),
				args,
			);
		} catch (err) {
			handleError(err);
		}
	},
});

const secrets = defineCommand({
	meta: { name: "secrets", description: "Named secrets referenced from agent.yaml as ${NAME}" },
	subCommands: {
		list: secretsList,
		set: secretsSet,
		unset: secretsUnset,
	},
});

// ── Commands: capabilities ─────────────────────────────────────────

function capabilitySetupCommands(capability: CapabilityDefinition): string[] {
	return capability.requirements.map((req) =>
		req.type === "provider_key"
			? providerFixCommand(req.provider, req.env)
			: secretFixCommand(req.suggestedName),
	);
}

const capabilitiesList = defineCommand({
	meta: { name: "list", description: "List known capabilities" },
	args: { json: { type: "boolean" } },
	run({ args }) {
		const list = CAPABILITY_REGISTRY.map((capability) => ({
			id: capability.id,
			label: capability.label,
			source: capability.source,
			requirements: capability.requirements,
			setup_commands: capabilitySetupCommands(capability),
		}));
		if (wantsJson(args)) {
			console.log(JSON.stringify(list));
			return;
		}
		printTable(
			list.map((capability) => ({
				id: capability.id,
				source:
					capability.source.type === "model"
						? `model:${capability.source.provider}`
						: `plugin:${capability.source.package}`,
				requires:
					capability.requirements.length === 0
						? "none"
						: capability.requirements.map((req) => req.type).join(","),
			})),
		);
	},
});

const capabilitiesExplain = defineCommand({
	meta: { name: "explain", description: "Explain a capability" },
	args: {
		id: { type: "positional", required: true },
		json: { type: "boolean" },
	},
	run({ args }) {
		const capability = CAPABILITY_BY_ID.get(args.id);
		if (!capability) fail(`Unknown capability: ${args.id}`, EXIT_CLI);
		const data = {
			id: capability.id,
			label: capability.label,
			description: capability.description,
			source: capability.source,
			requirements: capability.requirements,
			setup_commands: capabilitySetupCommands(capability),
		};
		if (wantsJson(args)) {
			console.log(JSON.stringify(data));
			return;
		}
		console.log(c.bold(`${data.id}: ${data.label}`));
		console.log(data.description);
		console.log(
			`source: ${data.source.type === "model" ? data.source.provider : data.source.package}`,
		);
		if (data.requirements.length === 0) {
			console.log("requires: none");
		} else {
			console.log("requires:");
			for (const req of data.requirements) {
				if (req.type === "provider_key") console.log(`  provider key: ${req.provider}`);
				else console.log(`  plugin secret: ${req.plugin}/${req.key}`);
			}
			console.log("setup:");
			for (const command of data.setup_commands) console.log(`  ${command}`);
		}
	},
});

const capabilitiesSetup = defineCommand({
	meta: { name: "setup", description: "Set the secret/key required by a capability" },
	args: {
		id: { type: "positional", required: true },
		"from-env": { type: "string", description: "Read the value from an environment variable" },
		stdin: { type: "boolean", description: "Read the value from stdin" },
		json: { type: "boolean" },
		server: { type: "string" },
	},
	async run({ args }) {
		requireAuth(args);
		const capability = CAPABILITY_BY_ID.get(args.id);
		if (!capability) fail(`Unknown capability: ${args.id}`, EXIT_CLI);
		if (capability.requirements.length === 0)
			fail(`Capability does not require setup: ${capability.id}`, EXIT_CLI);
		if (capability.requirements.length > 1)
			fail(
				`Capability has multiple requirements; use provider-keys or plugin-secrets directly.`,
				EXIT_CLI,
			);

		try {
			const requirement = capability.requirements[0];
			const secret = await readSecretValue({ fromEnv: args["from-env"], stdin: args.stdin });
			if (requirement.type === "provider_key") {
				const res = await apiFetch(resolveServer(args), "/provider-keys", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ provider: requirement.provider, key: secret.value }),
				});
				const data = (await res.json()) as { id: string; provider: string; key_prefix: string };
				outputSuccess(
					{ capability: capability.id, ...data, source: secret.source },
					`${c.green(`Set capability: ${capability.id}`)}  ${c.dim(data.key_prefix)}`,
					args,
				);
				return;
			}

			const res = await apiFetch(resolveServer(args), "/secrets", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name: requirement.suggestedName, value: secret.value }),
			});
			const data = (await res.json()) as {
				id: string;
				name: string;
				value_prefix: string;
			};
			outputSuccess(
				{ capability: capability.id, ...data, source: secret.source },
				`${c.green(`Set capability: ${capability.id}`)}  ${c.dim(`${data.name} (${data.value_prefix})`)}`,
				args,
			);
		} catch (err) {
			handleError(err);
		}
	},
});

const capabilitiesDoctor = defineCommand({
	meta: { name: "doctor", description: "Check whether an agent.yaml is ready to run" },
	args: {
		file: { type: "positional", description: "Path to agent.yaml", required: true },
		secret: {
			type: "string",
			description: "Secret override NAME=value the deploy would carry (repeatable)",
		},
		json: { type: "boolean" },
		server: { type: "string" },
	},
	async run({ args }) {
		requireAuth(args);
		try {
			const report = await buildCapabilityDoctorReport(
				args.file,
				resolveServer(args),
				parseSecretOverrides(args.secret),
			);
			renderDoctorReport(report, args);
			if (!report.ok) process.exit(EXIT_REQUIREMENTS);
		} catch (err) {
			if (wantsJson(args)) {
				console.log(
					JSON.stringify({
						schema_version: "parel.capability_doctor.v2",
						ok: false,
						agent_file: args.file,
						error: err instanceof Error ? err.message : String(err),
					}),
				);
				process.exit(err instanceof ApiError ? EXIT_API : EXIT_CLI);
			}
			handleError(err);
		}
	},
});

const capabilities = defineCommand({
	meta: { name: "capabilities", description: "Capability discovery and readiness checks" },
	subCommands: {
		list: capabilitiesList,
		explain: capabilitiesExplain,
		setup: capabilitiesSetup,
		doctor: capabilitiesDoctor,
	},
});

// ── Commands: billing ───────────────────────────────────────────────

const billingSummary = defineCommand({
	meta: { name: "summary", description: "Billing summary" },
	args: { json: { type: "boolean" }, server: { type: "string" } },
	async run({ args }) {
		requireAuth(args);
		try {
			const res = await apiFetch(resolveServer(args), "/billing/summary");
			const data = (await res.json()) as Record<string, unknown>;
			if (wantsJson(args)) {
				console.log(JSON.stringify(data));
				return;
			}
			console.log(c.bold("Billing Summary"));
			console.log(`  total tokens:   ${data.total_tokens}`);
			console.log(`  platform cost:  $${Number(data.platform_cost ?? 0).toFixed(4)}`);
			console.log(`  BYOK savings:   $${Number(data.byok_cost ?? 0).toFixed(4)}`);
			console.log(`  total records:  ${data.total_records}`);
		} catch (err) {
			handleError(err);
		}
	},
});

const billingBalance = defineCommand({
	meta: { name: "balance", description: "Current balance" },
	args: { json: { type: "boolean" }, server: { type: "string" } },
	async run({ args }) {
		requireAuth(args);
		try {
			const res = await apiFetch(resolveServer(args), "/billing/balance");
			const data = (await res.json()) as Record<string, unknown>;
			if (wantsJson(args)) {
				console.log(JSON.stringify(data));
				return;
			}
			console.log(`  balance: $${Number(data.balance ?? 0).toFixed(2)}`);
			if (data.has_payment_method) {
				console.log(
					`  auto top-up: ${c.green("on")} (threshold: $${data.auto_topup_threshold}, amount: $${data.auto_topup_amount})`,
				);
			} else {
				console.log(`  auto top-up: ${c.dim("off (no payment method)")}`);
			}
		} catch (err) {
			handleError(err);
		}
	},
});

const billing = defineCommand({
	meta: { name: "billing", description: "Billing and usage" },
	subCommands: { summary: billingSummary, balance: billingBalance },
});

// ── Root ─────────────────────────────────────────────────────────────

// Single source of truth: the published package version.
const VERSION = pkg.version;

function printHelp(): void {
	const g = c.green;
	const d = c.dim;
	console.log(`
${c.bold("PAREL")} ${d(`v${VERSION}`)} — deploy and manage AI agents

${c.bold("QUICK START")}
  ${g("parel send")} --agent <id> -m "text"     Send message, wait for response
  ${g("parel run")}  agent.yaml -m "text"        Deploy + send in one shot
  ${g("parel try")}  <agent> -m "text"           Throwaway run ${d("(ephemeral)")}
  ${g("parel chat")} --agent <id>                Interactive REPL ${d("(for humans)")}

${c.bold("ENVIRONMENT")}
  ${g("PAREL_API_KEY")}     API key ${d("(alternative to parel login)")}
  ${g("PAREL_JSON=1")}      Machine-readable JSON on all commands
  ${g("PAREL_SERVER")}      Override API server URL

${c.bold("COMMANDS")}
  ${g("send")}, ${g("run")}, ${g("try")}            Send messages, get results
  ${g("deploy")}, ${g("promote")}, ${g("agents")}     Deploy, roll out, manage configs
  ${g("instances")}                 Pin versions, reset instance state
  ${g("sessions")}, ${g("chat")}             Session lifecycle
  ${g("logs")}, ${g("steer")}               Observe and control running agents
  ${g("capabilities")}              Check agent.yaml readiness
  ${g("provider-keys")}             Manage model credentials
  ${g("secrets")}                   Named secrets for \${NAME} config references
  ${g("api-keys")}, ${g("billing")}          Account management
  ${g("login")}, ${g("whoami")}, ${g("config")}      Authentication and settings

${d("Run parel <command> -h for command-specific help.")}
`);
}

const arg = process.argv[2];
if (!arg || arg === "-h" || arg === "--help") {
	printHelp();
	process.exit(0);
}
if (arg === "-v" || arg === "--version") {
	console.log(VERSION);
	process.exit(0);
}

const main = defineCommand({
	meta: { name: "parel", version: VERSION, description: "PAREL — deploy and manage AI agents" },
	subCommands: {
		send,
		run,
		deploy,
		try: tryRun,
		chat,
		agents,
		versions,
		deployments,
		rollback,
		promote,
		instances,
		sessions,
		logs,
		steer,
		"api-keys": apiKeys,
		"provider-keys": providerKeys,
		secrets,
		capabilities,
		billing,
		login,
		whoami,
		config,
	},
});

runMain(main);
