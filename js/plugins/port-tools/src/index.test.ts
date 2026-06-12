import type { PluginContext, ToolDefinition, ToolHandler } from "@parel/plugin-sdk";
import { describe, expect, it, vi } from "vitest";
import type { PortHandle, PortsCapability } from "./index.js";
import portToolsPlugin from "./index.js";

interface Harness {
	ctx: PluginContext;
	tools: Map<string, { def: ToolDefinition; handler: ToolHandler }>;
	expose: ReturnType<typeof vi.fn>;
}

function makeHarness() {
	const tools = new Map<string, { def: ToolDefinition; handler: ToolHandler }>();
	const records = new Map<number, PortHandle>();
	const expose = vi.fn(async (port: number, opts?: { protocol?: "http" | "https" }) => {
		const protocol = opts?.protocol ?? "https";
		const handle: PortHandle = {
			id: String(port),
			port,
			host: `${port}.sandbox.example`,
			url: `${protocol}://${port}.sandbox.example`,
			protocol,
			createdAt: "now",
		};
		records.set(port, handle);
		return handle;
	});
	const ports: PortsCapability = {
		expose,
		async list() {
			return [...records.values()];
		},
		async revoke(port) {
			return records.delete(port);
		},
	};
	const ctx = {
		config: {},
		store: {} as PluginContext["store"],
		inputs: {} as PluginContext["inputs"],
		model: {} as PluginContext["model"],
		log: { debug() {}, info() {}, warn() {}, error() {} },
		require<T>(name: string): T {
			if (name === "ports") return ports as T;
			throw new Error(`capability not provided: ${name}`);
		},
		tool(def: ToolDefinition, handler: ToolHandler) {
			tools.set(def.name, { def, handler });
		},
		provide() {},
		hook() {},
		interrupt() {},
	} as unknown as PluginContext;
	return { ctx, tools, expose } satisfies Harness;
}

describe("@parel/port-tools", () => {
	it("exposes and lists ports", async () => {
		const h = makeHarness();
		await portToolsPlugin.setup(h.ctx);

		const expose = h.tools.get("workspace_expose_port");
		expect(expose).toBeDefined();
		const exposed = await expose?.handler({ port: 3000, protocol: "http" }, {} as never);

		expect(JSON.parse(String(exposed))).toMatchObject({
			port: 3000,
			url: "http://3000.sandbox.example",
		});
		expect(h.expose).toHaveBeenCalledWith(3000, { protocol: "http" });

		const list = await h.tools.get("workspace_list_ports")?.handler({}, {} as never);
		expect(JSON.parse(String(list))).toEqual([
			expect.objectContaining({ port: 3000, url: "http://3000.sandbox.example" }),
		]);
		expect(h.tools.get("workspace_list_ports")?.def.scheduling?.defaultMode).toBe("parallel");
	});

	it("revokes ports", async () => {
		const h = makeHarness();
		await portToolsPlugin.setup(h.ctx);
		await h.tools.get("workspace_expose_port")?.handler({ port: 3000 }, {} as never);

		const revoked = await h.tools
			.get("workspace_revoke_port")
			?.handler({ port: 3000 }, {} as never);
		const missing = await h.tools
			.get("workspace_revoke_port")
			?.handler({ port: 3000 }, {} as never);

		expect(revoked).toBe("Revoked port 3000.");
		expect(missing).toBe("Port 3000 was not exposed.");
	});

	it("validates port and protocol parameters", async () => {
		const h = makeHarness();
		await portToolsPlugin.setup(h.ctx);

		await expect(
			h.tools.get("workspace_expose_port")?.handler({ port: 0 }, {} as never),
		).rejects.toThrow("between 1 and 65535");
		await expect(
			h.tools.get("workspace_expose_port")?.handler({ port: 3000, protocol: "ftp" }, {} as never),
		).rejects.toThrow("protocol");
	});
});
