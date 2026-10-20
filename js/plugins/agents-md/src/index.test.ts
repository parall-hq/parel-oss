import { PAREL_SANDBOX_CAPABILITY, type SandboxCapability } from "@parel/capability-sandbox";
import type { PluginContext, SessionStore } from "@parel/plugin-sdk";
import { WORKSPACE_CAPABILITY, type WorkspaceCapability } from "@parel/workspace";
import { describe, expect, it } from "vitest";
import agentsMdPlugin from "./index.js";

type Hook = (ctx: unknown) => Promise<unknown>;

function makeStore(): SessionStore {
	const values = new Map<string, unknown>();
	return {
		async get<T>(key: string) {
			return (values.has(key) ? (values.get(key) as T) : null) as T | null;
		},
		async set<T>(key: string, value: T) {
			values.set(key, JSON.parse(JSON.stringify(value)));
		},
		async delete(key: string) {
			values.delete(key);
		},
		async list(prefix?: string) {
			return [...values.keys()].filter((key) => !prefix || key.startsWith(prefix));
		},
	};
}

/** In-memory sandbox filesystem keyed by the exact path the plugin passes. */
function makeSandbox(initial: Record<string, string>, opts: { cwd?: string } = {}) {
	const files = new Map(Object.entries(initial));
	const listed: string[] = [];
	const read: string[] = [];
	const sandbox: SandboxCapability = {
		provider: "fake",
		...(opts.cwd ? { cwd: opts.cwd } : {}),
		fs: {
			async readFile(path, readOpts) {
				read.push(path);
				const text = files.get(path);
				if (text === undefined) throw new Error(`ENOENT: ${path}`);
				return readOpts?.maxChars ? text.slice(0, readOpts.maxChars) : text;
			},
			async writeFile(path, content) {
				files.set(path, content);
			},
			async listDir(dir) {
				listed.push(dir);
				const prefix = dir === "." ? "" : dir.endsWith("/") ? dir : `${dir}/`;
				const names = new Set<string>();
				for (const path of files.keys()) {
					if (!path.startsWith(prefix)) continue;
					const [name] = path.slice(prefix.length).split("/");
					if (name) names.add(name);
				}
				return [...names].map((name) => ({ name }));
			},
		},
	};
	return { sandbox, files, listed, read };
}

function workspaceAt(root: string | undefined): WorkspaceCapability {
	return {
		async current() {
			return { id: "ws_1", identity: {}, metadata: {}, ...(root ? { root } : {}) };
		},
		async materialize() {
			throw new Error("the plugin must not materialize the workspace");
		},
		async root() {
			throw new Error("the plugin must not materialize the workspace");
		},
		async export() {
			throw new Error("not implemented");
		},
		async metadata() {
			return {};
		},
	};
}

async function setup(opts: {
	capabilities?: Record<string, unknown>;
	config?: Record<string, unknown>;
	store?: SessionStore;
}) {
	const hooks = new Map<string, Hook>();
	const warnings: string[] = [];
	const store = opts.store ?? makeStore();
	const capabilities = opts.capabilities ?? {};
	const ctx = {
		config: opts.config ?? {},
		store,
		inputs: {},
		model: {},
		log: {
			debug() {},
			info() {},
			warn(message: string) {
				warnings.push(message);
			},
			error() {},
		},
		hook(event: string, handler: Hook) {
			hooks.set(event, handler);
		},
		tool() {},
		provide() {},
		require<T>(name: string): T {
			if (name in capabilities) return capabilities[name] as T;
			throw new Error(`capability not provided: ${name}`);
		},
		interrupt() {},
	} as unknown as PluginContext;
	await agentsMdPlugin.setup(ctx);

	const run = (event: string, hookCtx: unknown) => {
		const hook = hooks.get(event);
		if (!hook) throw new Error(`no ${event} hook`);
		return hook(hookCtx);
	};
	return {
		store,
		warnings,
		startTurn: () => run("turn:start", {}),
		/** The system prompt after context:build, or undefined when the plugin left it alone. */
		async buildSystem(system = "SYS"): Promise<string | undefined> {
			const result = (await run("context:build", { system, messages: [] })) as
				| { mutations: { system: string } }
				| undefined;
			return result?.mutations.system;
		},
		touch(name: string, path: string, opts: { isError?: boolean } = {}) {
			return run("tool:after", {
				toolCall: { id: "call_1", name, arguments: { path } },
				toolResult: { toolCallId: "call_1", content: "ok", isError: opts.isError ?? false },
			});
		},
	};
}

function sandboxOnly(sandbox: SandboxCapability) {
	return { [PAREL_SANDBOX_CAPABILITY]: sandbox };
}

describe("@parel/agents-md", () => {
	it("appends the root AGENTS.md to the system prompt", async () => {
		const fake = makeSandbox({ "AGENTS.md": "Run pnpm test before you finish." });
		const h = await setup({ capabilities: sandboxOnly(fake.sandbox) });

		await h.startTurn();
		const system = await h.buildSystem();

		expect(system?.startsWith("SYS\n\n<agents_md>\n")).toBe(true);
		expect(system).toContain('<file path="AGENTS.md">\nRun pnpm test before you finish.\n</file>');
		expect(system).toContain("the sandbox working directory");
		expect(h.warnings).toEqual([]);
	});

	it("prefers AGENTS.md, then agents.md, then AGENT.md", async () => {
		const both = makeSandbox({ "AGENTS.md": "upper", "AGENT.md": "legacy" });
		const h1 = await setup({ capabilities: sandboxOnly(both.sandbox) });
		const s1 = await h1.buildSystem();
		expect(s1).toContain("upper");
		expect(s1).not.toContain("legacy");

		const legacy = makeSandbox({ "AGENT.md": "legacy", "agents.md": "lower" });
		const h2 = await setup({ capabilities: sandboxOnly(legacy.sandbox) });
		const s2 = await h2.buildSystem();
		expect(s2).toContain('<file path="agents.md">\nlower');
		expect(s2).not.toContain("legacy");
	});

	it("reads the files once per turn and again on the next turn", async () => {
		const fake = makeSandbox({ "AGENTS.md": "v1" });
		const h = await setup({ capabilities: sandboxOnly(fake.sandbox) });

		await h.startTurn();
		await h.buildSystem();
		await h.buildSystem(); // a second step in the same turn
		expect(fake.read).toEqual(["AGENTS.md"]);

		fake.files.set("AGENTS.md", "v2");
		await h.startTurn();
		expect(await h.buildSystem()).toContain("v2");
		expect(fake.read).toEqual(["AGENTS.md", "AGENTS.md"]);
	});

	it("loads the AGENTS.md files on the path to a file the model reads", async () => {
		const fake = makeSandbox({
			"AGENTS.md": "root rules",
			"src/AGENTS.md": "src rules",
			"src/api/AGENTS.md": "api rules",
			"src/api/auth.ts": "export {}",
			"docs/AGENTS.md": "docs rules",
		});
		const h = await setup({ capabilities: sandboxOnly(fake.sandbox) });

		await h.startTurn();
		const before = await h.buildSystem();
		expect(before).toContain("root rules");
		expect(before).not.toContain("src rules");

		await h.touch("workspace_read_file", "src/api/auth.ts");
		const after = await h.buildSystem();
		const order = ["root rules", "src rules", "api rules"].map((text) => after?.indexOf(text));
		expect(order.every((index) => index !== undefined && index > 0)).toBe(true);
		expect(order).toEqual([...(order as number[])].sort((a, b) => a - b)); // shallow to deep
		expect(after).toContain('<file path="src/api/AGENTS.md">');
		expect(after).not.toContain("docs rules");
		expect(await h.store.get("loaded_dirs")).toEqual(["src", "src/api"]);
	});

	it("loads on writes and edits too, but not on failed calls or other tools", async () => {
		const fake = makeSandbox({
			"a/AGENTS.md": "a rules",
			"b/AGENTS.md": "b rules",
			"c/AGENTS.md": "c rules",
			"d/AGENTS.md": "d rules",
		});
		const h = await setup({ capabilities: sandboxOnly(fake.sandbox) });

		await h.touch("workspace_write_file", "a/new.ts");
		await h.touch("workspace_edit_file", "b/x.ts");
		await h.touch("workspace_read_file", "c/missing.ts", { isError: true });
		await h.touch("workspace_list_dir", "d/x.ts");
		const system = await h.buildSystem();

		expect(system).toContain("a rules");
		expect(system).toContain("b rules");
		expect(system).not.toContain("c rules");
		expect(system).not.toContain("d rules");
	});

	it("loads each subdirectory file once and keeps it loaded on later turns", async () => {
		const fake = makeSandbox({ "pkg/AGENTS.md": "pkg rules", "pkg/a.ts": "", "pkg/b.ts": "" });
		const h = await setup({ capabilities: sandboxOnly(fake.sandbox) });

		await h.startTurn();
		await h.buildSystem();
		await h.touch("workspace_read_file", "pkg/a.ts");
		await h.touch("workspace_read_file", "pkg/b.ts");
		const system = await h.buildSystem();
		expect(system?.split("pkg rules")).toHaveLength(2); // exactly once
		expect(fake.listed.filter((dir) => dir === "pkg")).toHaveLength(1);

		await h.startTurn();
		const next = await h.buildSystem();
		expect(next?.split("pkg rules")).toHaveLength(2);
		await h.touch("workspace_read_file", "pkg/a.ts");
		expect(await h.store.get("loaded_dirs")).toEqual(["pkg"]);
	});

	it("restores loaded subdirectory files from the session store", async () => {
		const fake = makeSandbox({ "pkg/AGENTS.md": "pkg rules", "pkg/a.ts": "" });
		const store = makeStore();
		const first = await setup({ capabilities: sandboxOnly(fake.sandbox), store });
		await first.touch("workspace_read_file", "pkg/a.ts");

		// A fresh plugin instance (new isolate, resumed session) over the same store.
		const second = await setup({ capabilities: sandboxOnly(fake.sandbox), store });
		await second.startTurn();
		expect(await second.buildSystem()).toContain("pkg rules");
	});

	it("resolves workspace paths against the workspace root and absolute paths inside it", async () => {
		const fake = makeSandbox({
			"/workspace/repo/AGENTS.md": "repo rules",
			"/workspace/repo/web/AGENTS.md": "web rules",
			"/workspace/repo/api/AGENTS.md": "api rules",
			"/workspace/other/AGENTS.md": "other rules",
		});
		const h = await setup({
			capabilities: {
				[PAREL_SANDBOX_CAPABILITY]: fake.sandbox,
				[WORKSPACE_CAPABILITY]: workspaceAt("/workspace/repo/"),
			},
		});

		await h.touch("workspace_read_file", "web/page.tsx");
		await h.touch("file_read", "/workspace/repo/api/server.ts");
		await h.touch("file_read", "/workspace/other/x.ts");
		await h.touch("workspace_read_file", "../other/x.ts");
		const system = await h.buildSystem();

		expect(system).toContain("in /workspace/repo.");
		expect(system).toContain('<file path="AGENTS.md">\nrepo rules');
		expect(system).toContain('<file path="web/AGENTS.md">\nweb rules');
		expect(system).toContain('<file path="api/AGENTS.md">\napi rules');
		expect(system).not.toContain("other rules");
	});

	it("uses the configured root over the workspace and the sandbox cwd", async () => {
		const fake = makeSandbox(
			{ "/srv/app/AGENTS.md": "configured", "/home/user/AGENTS.md": "cwd" },
			{ cwd: "/home/user" },
		);
		const configured = await setup({
			capabilities: {
				[PAREL_SANDBOX_CAPABILITY]: fake.sandbox,
				[WORKSPACE_CAPABILITY]: workspaceAt("/workspace/repo"),
			},
			config: { root: "/srv/app" },
		});
		expect(await configured.buildSystem()).toContain("configured");

		// No config, workspace not materialized yet: fall back to the sandbox cwd.
		const fallback = await setup({
			capabilities: {
				[PAREL_SANDBOX_CAPABILITY]: fake.sandbox,
				[WORKSPACE_CAPABILITY]: workspaceAt(undefined),
			},
		});
		expect(await fallback.buildSystem()).toContain("cwd");
	});

	it("cuts files at the character limit and says what was cut", async () => {
		const fake = makeSandbox({
			"AGENTS.md": "r".repeat(30),
			"x/AGENTS.md": "x".repeat(30),
			"y/AGENTS.md": "y".repeat(30),
		});
		const h = await setup({ capabilities: sandboxOnly(fake.sandbox), config: { maxChars: 40 } });

		await h.touch("workspace_read_file", "x/file.ts");
		await h.touch("workspace_read_file", "y/file.ts");
		const system = await h.buildSystem();

		expect(system).toContain(`${"r".repeat(30)}\n</file>`);
		expect(system).toContain(
			`${"x".repeat(10)}\n[truncated: x/AGENTS.md goes past the 40-character limit for AGENTS.md files; the rest of it is not loaded]`,
		);
		expect(system).not.toContain("x".repeat(11));
		expect(system).toContain(
			'<file path="y/AGENTS.md">\n[not loaded: the 40-character limit for AGENTS.md files is used up]',
		);
	});

	it("reads at most one character past the limit", async () => {
		const fake = makeSandbox({ "AGENTS.md": "z".repeat(500) });
		let requested: number | undefined;
		const readFile = fake.sandbox.fs?.readFile;
		if (!fake.sandbox.fs || !readFile) throw new Error("fake sandbox has no fs");
		fake.sandbox.fs.readFile = (path, opts) => {
			requested = opts?.maxChars;
			return readFile(path, opts);
		};
		const h = await setup({ capabilities: sandboxOnly(fake.sandbox), config: { maxChars: 100 } });

		expect(await h.buildSystem()).toContain("[truncated: AGENTS.md");
		expect(requested).toBe(101);
	});

	it("does nothing when there are no AGENTS.md files", async () => {
		const fake = makeSandbox({ "src/index.ts": "", "README.md": "# hi" });
		const h = await setup({ capabilities: sandboxOnly(fake.sandbox) });

		expect(await h.buildSystem()).toBeUndefined();
		await h.touch("workspace_read_file", "src/index.ts");
		expect(await h.buildSystem()).toBeUndefined();
		expect(await h.store.get("loaded_dirs")).toBeNull();
		expect(h.warnings).toEqual([]);
	});

	it("skips an empty AGENTS.md", async () => {
		const fake = makeSandbox({ "AGENTS.md": "  \n" });
		const h = await setup({ capabilities: sandboxOnly(fake.sandbox) });
		expect(await h.buildSystem()).toBeUndefined();
	});

	it("does nothing without a sandbox, and warns once", async () => {
		const h = await setup({ capabilities: {} });

		expect(await h.buildSystem()).toBeUndefined();
		await h.touch("workspace_read_file", "src/a.ts");
		expect(await h.buildSystem()).toBeUndefined();
		expect(h.warnings).toHaveLength(1);
	});

	it("does nothing when the sandbox has no filesystem", async () => {
		const h = await setup({ capabilities: sandboxOnly({ provider: "no-fs" }) });
		expect(await h.buildSystem()).toBeUndefined();
	});

	it("never fails a turn when the sandbox filesystem errors", async () => {
		const broken: SandboxCapability = {
			provider: "broken",
			fs: {
				async readFile() {
					throw new Error("sandbox is gone");
				},
				async writeFile() {
					throw new Error("sandbox is gone");
				},
				async listDir() {
					throw new Error("sandbox is gone");
				},
			},
		};
		const h = await setup({ capabilities: sandboxOnly(broken) });

		await expect(h.buildSystem()).resolves.toBeUndefined();
		await expect(h.touch("workspace_read_file", "src/a.ts")).resolves.toBeUndefined();
		expect(h.warnings.some((message) => message.includes("sandbox is gone"))).toBe(true);
	});

	it("never fails a turn when the store errors", async () => {
		const fake = makeSandbox({ "AGENTS.md": "rules" });
		const store = makeStore();
		store.get = async () => {
			throw new Error("store unavailable");
		};
		const h = await setup({ capabilities: sandboxOnly(fake.sandbox), store });

		await expect(h.buildSystem()).resolves.toBeUndefined();
		expect(h.warnings.some((message) => message.includes("store unavailable"))).toBe(true);
	});
});
