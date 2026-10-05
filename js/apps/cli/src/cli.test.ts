import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";

// Runs the real CLI (through tsx) against a local fake of the PAREL API, so the
// tests cover each command's wiring: request shape, paging, output, exit code.

interface Call {
	method: string;
	path: string;
	body: unknown;
}
type Reply = { status?: number; body: unknown };

const CLI_DIR = fileURLToPath(new URL("..", import.meta.url));
let server: Server;
let base: string;
let home: string;
let routes: Record<string, Reply> = {};
/** Frames the fake session WebSocket sends after the CLI's message. */
let wsFrames: unknown[] = [];
const calls: Call[] = [];

beforeAll(async () => {
	server = createServer(async (req, res) => {
		const chunks: Buffer[] = [];
		for await (const chunk of req) chunks.push(chunk as Buffer);
		const text = Buffer.concat(chunks).toString("utf-8");
		let body: unknown = text || undefined;
		try {
			body = text ? JSON.parse(text) : undefined;
		} catch {}
		const call = { method: req.method ?? "", path: req.url ?? "", body };
		calls.push(call);
		const reply = routes[`${call.method} ${call.path}`] ?? {
			status: 404,
			body: { error: "Not found", code: "not_found" },
		};
		res.writeHead(reply.status ?? 200, { "Content-Type": "application/json" });
		res.end(JSON.stringify(reply.body));
	});
	server.on("upgrade", (req, socket) => {
		const accept = createHash("sha1")
			.update(`${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
			.digest("base64");
		socket.write(
			[
				"HTTP/1.1 101 Switching Protocols",
				"Upgrade: websocket",
				"Connection: Upgrade",
				`Sec-WebSocket-Accept: ${accept}`,
				"Sec-WebSocket-Protocol: parel-v1",
				"",
				"",
			].join("\r\n"),
		);
		socket.on("error", () => {});
		socket.on("end", () => socket.end());
		// First data = the CLI's message frame: answer with the scripted frames.
		// Like the runtime, never answer the CLI's close frame: the CLI must not
		// wait for the closing handshake once it has its result.
		socket.once("data", () => {
			for (const frame of wsFrames) socket.write(textFrame(JSON.stringify(frame)));
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	home = mkdtempSync(join(tmpdir(), "parel-cli-test-"));
});

afterAll(async () => {
	await new Promise((resolve) => server.close(resolve));
	rmSync(home, { recursive: true, force: true });
});

afterEach(() => {
	calls.length = 0;
	routes = {};
	wsFrames = [];
});

function textFrame(text: string): Buffer {
	const payload = Buffer.from(text);
	const header =
		payload.length < 126
			? Buffer.from([0x81, payload.length])
			: Buffer.from([0x81, 126, payload.length >> 8, payload.length & 0xff]);
	return Buffer.concat([header, payload]);
}

function cli(
	args: string[],
	env: Record<string, string> = {},
): Promise<{ code: number | null; stdout: string; stderr: string }> {
	return new Promise((resolve) => {
		const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts", ...args], {
			cwd: CLI_DIR,
			env: {
				PATH: process.env.PATH ?? "",
				HOME: home,
				NO_COLOR: "1",
				PAREL_API_KEY: "pk_test",
				PAREL_SERVER: base,
				...env,
			},
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => (stdout += chunk));
		child.stderr.on("data", (chunk) => (stderr += chunk));
		child.on("close", (code) => resolve({ code, stdout, stderr }));
	});
}

function agentFile(yaml: string): string {
	const file = join(home, `agent-${Math.random().toString(36).slice(2)}.yaml`);
	writeFileSync(file, yaml);
	return file;
}

const E2B_AGENT = `agent:
  name: bot
model:
  provider: anthropic
  model: claude-sonnet-4-5
plugins:
  - plugin: "@parel/sandbox-e2b"
    config:
      apiKey: \${E2B_API_KEY}
`;

const posted = (path: string) => calls.find((c) => c.method === "POST" && c.path === path);

describe("parel logs", () => {
	test("pages through events and prints them with the log records", async () => {
		const evt = (seq: number, type: string) => ({
			id: `evt_${seq}`,
			seq,
			type,
			data: JSON.stringify({ n: seq }),
			created_at: `2026-10-05T10:00:0${seq}`,
		});
		routes = {
			"GET /sessions/ssn_1/events?since_seq=0&limit=1000": {
				body: {
					events: [evt(1, "turn:start"), evt(2, "step:start")],
					hasMore: true,
					nextSeq: 2,
					earliestAvailableSeq: 1,
				},
			},
			"GET /sessions/ssn_1/events?since_seq=2&limit=1000": {
				body: { events: [evt(3, "turn:end")], hasMore: false, nextSeq: 3, earliestAvailableSeq: 1 },
			},
			"GET /sessions/ssn_1/logs": {
				body: [
					{ id: "log_1", type: "llm", data: '{"model":"x"}', created_at: "2026-10-05T10:00:02" },
				],
			},
		};
		const { code, stdout } = await cli(["logs", "ssn_1"]);
		expect(code).toBe(0);
		expect(stdout).toContain("[1] turn:start");
		expect(stdout).toContain("[2] step:start");
		expect(stdout).toContain("[3] turn:end");
		expect(stdout).toMatch(/Logs\n.*llm {2}\{"model":"x"\}/);

		const json = await cli(["logs", "ssn_1", "--json"]);
		const parsed = JSON.parse(json.stdout);
		expect(parsed.events.map((e: { seq: number }) => e.seq)).toEqual([1, 2, 3]);
		expect(parsed.logs).toHaveLength(1);
		expect(parsed.earliestAvailableSeq).toBe(1);
	});

	test("says so when a session has nothing yet", async () => {
		routes = {
			"GET /sessions/ssn_2/events?since_seq=0&limit=1000": {
				body: { events: [], hasMore: false },
			},
			"GET /sessions/ssn_2/logs": { body: [] },
		};
		const { code, stdout } = await cli(["logs", "ssn_2"]);
		expect(code).toBe(0);
		expect(stdout.trim()).toBe("No events or logs for ssn_2 yet.");
	});
});

describe("parel api-keys create", () => {
	const created = (scopes: string) => ({
		status: 201,
		body: { id: "key_1", name: "ci", key: "pk_new", key_prefix: "pk_new...", scopes },
	});

	test("sends --scope to the server", async () => {
		routes = { "POST /api-keys": created("admin") };
		const { code, stdout } = await cli(["api-keys", "create", "ci", "--scope", "admin"]);
		expect(code).toBe(0);
		expect(posted("/api-keys")?.body).toEqual({ name: "ci", scopes: "admin" });
		expect(stdout).toContain("Created: ci (admin)");
	});

	test("leaves the default (write) to the server", async () => {
		routes = { "POST /api-keys": created("write") };
		await cli(["api-keys", "create", "ci"]);
		expect(posted("/api-keys")?.body).toEqual({ name: "ci" });
	});

	test("rejects an unknown scope before calling the server", async () => {
		const { code, stderr } = await cli(["api-keys", "create", "ci", "--scope", "owner"]);
		expect(code).toBe(1);
		expect(stderr).toContain("--scope must be one of: read, write, admin");
		expect(calls).toHaveLength(0);
	});
});

describe("parel deploy --no-activate", () => {
	test("doesn't upload secrets for an existing agent; the stored value is used", async () => {
		routes = {
			"GET /agents/bot": { body: { id: "agt_1", name: "bot" } },
			"GET /secrets": {
				body: [{ id: "sec_1", name: "E2B_API_KEY", agent_id: "", value_prefix: "e2b_***" }],
			},
			"POST /agents/bot/versions?activate=false": {
				body: { id: "agt_1", name: "bot", version: 2, active: false },
			},
		};
		const file = agentFile(E2B_AGENT);
		const { code, stdout } = await cli(["deploy", file, "--no-activate"], {
			E2B_API_KEY: "e2b_local_value",
		});
		expect(code).toBe(0);
		// No secrets means the plain YAML body, not the JSON one that carries them.
		const body = posted("/agents/bot/versions?activate=false")?.body;
		expect(typeof body).toBe("string");
		expect(String(body)).not.toContain("e2b_local_value");
		expect(stdout).toContain("not uploaded");
		expect(stdout).toContain("Staged: bot v2");
	});

	test("fails early when a referenced secret isn't stored", async () => {
		routes = {
			"GET /agents/bot": { body: { id: "agt_1", name: "bot" } },
			"GET /secrets": { body: [] },
		};
		const file = agentFile(E2B_AGENT);
		const { code, stderr } = await cli(["deploy", file, "--no-activate"], {
			E2B_API_KEY: "e2b_local_value",
		});
		expect(code).toBe(1);
		expect(stderr).toContain("parel secrets set E2B_API_KEY --agent bot");
		expect(calls.some((c) => c.method === "POST")).toBe(false);
	});

	test("a new agent's first version is live, so it uploads secrets as usual", async () => {
		routes = {
			"POST /agents/bot/versions?activate=false": {
				status: 201,
				body: { id: "agt_1", name: "bot", version: 1, active: true },
			},
		};
		const file = agentFile(E2B_AGENT);
		const { code } = await cli(["deploy", file, "--no-activate"], { E2B_API_KEY: "e2b_local" });
		expect(code).toBe(0);
		expect(posted("/agents/bot/versions?activate=false")?.body).toMatchObject({
			secrets: { E2B_API_KEY: "e2b_local" },
		});
	});
});

describe("parel deploy with channels", () => {
	test("uploads channel secret references and prints each channel's result", async () => {
		routes = {
			"POST /agents/bot/versions": {
				body: {
					id: "agt_1",
					name: "bot",
					version: 3,
					active: true,
					channels: [
						{
							plugin: "@parel/channel-slack-socket",
							type: "managed_ws",
							connectionId: "chn_1",
							status: "provisioned",
						},
						{
							plugin: "@parel/channel-generic-webhook",
							type: "webhook",
							status: "error",
							error: "webhook connections require config.webhookSecret",
						},
					],
				},
			},
		};
		const file = agentFile(`agent:
  name: bot
model:
  provider: anthropic
  model: claude-sonnet-4-5
channels:
  - type: managed_ws
    plugin: "@parel/channel-slack-socket"
    config:
      appToken: \${SLACK_APP_TOKEN}
`);
		const { code, stdout } = await cli(["deploy", file], { SLACK_APP_TOKEN: "xapp-1-secret" });
		expect(code).toBe(0);
		expect(posted("/agents/bot/versions")?.body).toMatchObject({
			secrets: { SLACK_APP_TOKEN: "xapp-1-secret" },
		});
		expect(stdout).toContain("channel managed_ws @parel/channel-slack-socket  provisioned  chn_1");
		expect(stdout).toContain(
			"channel webhook @parel/channel-generic-webhook  error: webhook connections require config.webhookSecret",
		);
	});
});

describe("server errors", () => {
	test("show the server's details, not only its summary", async () => {
		routes = {
			"POST /agents/bot/versions": {
				status: 400,
				body: {
					error: "Invalid agent config",
					code: "config_invalid",
					details: "version: Required",
				},
			},
		};
		const { code, stderr } = await cli(["deploy", agentFile(E2B_AGENT)]);
		expect(code).toBe(2);
		expect(stderr).toContain("Error: Invalid agent config: version: Required");
	});
});

describe("--agent takes a name", () => {
	test("sessions list resolves the name to the id the filter needs", async () => {
		routes = {
			"GET /agents/bot": { body: { id: "agt_1", name: "bot" } },
			"GET /sessions?agent_id=agt_1&limit=20": { body: [] },
		};
		const { code } = await cli(["sessions", "list", "--agent", "bot"]);
		expect(code).toBe(0);
		expect(calls.map((c) => c.path)).toEqual(["/agents/bot", "/sessions?agent_id=agt_1&limit=20"]);
	});

	test("secrets set sends the resolved agent id", async () => {
		routes = {
			"GET /agents/bot": { body: { id: "agt_1", name: "bot" } },
			"POST /secrets": {
				body: { id: "sec_1", name: "GH_TOKEN", agent_id: "agt_1", value_prefix: "ghp_***" },
			},
		};
		const { code } = await cli(["secrets", "set", "GH_TOKEN", "--agent", "bot"], {
			GH_TOKEN: "ghp_value",
		});
		expect(code).toBe(0);
		expect(posted("/secrets")?.body).toEqual({
			name: "GH_TOKEN",
			value: "ghp_value",
			agentId: "agt_1",
		});
	});
});

describe("parel send", () => {
	const session = { "POST /sessions": { status: 201, body: { id: "ssn_1", status: "ready" } } };

	test("returns when a slash command finishes without a turn", async () => {
		routes = session;
		wsFrames = [
			{
				type: "command_result",
				inputId: "in_1",
				name: "help",
				args: "",
				ok: true,
				reply: "/compact",
			},
			{ type: "message_ack", status: "executed", inputId: "in_1" },
		];
		const { code, stdout } = await cli(["send", "--agent", "bot", "-m", "/help", "-t", "10"]);
		expect(code).toBe(0);
		expect(stdout.trim()).toBe("/compact");
	});

	test("records the tool result content", async () => {
		routes = session;
		wsFrames = [
			{ type: "message_ack", status: "accepted", inputId: "in_1", turnId: "trn_1" },
			{ type: "tool_call", callId: "c1", name: "read_file", arguments: { path: "a" } },
			{
				type: "tool_result",
				callId: "c1",
				name: "read_file",
				content: "file body",
				isError: false,
			},
			{ type: "text", text: "Done." },
			{ type: "turn_end", state: {} },
		];
		const { code, stdout } = await cli(["send", "--agent", "bot", "-m", "read a", "--json"]);
		expect(code).toBe(0);
		const result = JSON.parse(stdout);
		expect(result.response).toBe("Done.");
		expect(result.messages[0]).toEqual({ role: "tool_result", content: "file body" });
	});
});

describe("parel login", () => {
	test("a network error exits 1, like every other command", async () => {
		const { code, stderr } = await cli(["login", "--key", "pk_abc"], {
			PAREL_SERVER: "http://127.0.0.1:1",
		});
		expect(code).toBe(1);
		expect(stderr).toContain("Cannot reach server");
		expect(existsSync(join(home, ".parel", "config.json"))).toBe(false);
	});

	test("a rejected key exits 2 (the server answered with an error)", async () => {
		routes = { "GET /agents": { status: 401, body: { error: "Unauthorized" } } };
		const { code } = await cli(["login", "--key", "pk_bad"]);
		expect(code).toBe(2);
	});
});
