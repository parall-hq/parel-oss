import { definePlugin } from "@parel/plugin-sdk";

export interface PortHandle {
	id: string;
	port: number;
	host: string;
	url: string;
	protocol: string;
	createdAt: string;
}

export interface PortsCapability {
	expose(port: number, opts?: { protocol?: "http" | "https" }): Promise<PortHandle>;
	list(): Promise<PortHandle[]>;
	revoke(port: number): Promise<boolean>;
}

interface PortParams {
	port?: unknown;
	protocol?: unknown;
}

function portParam(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new Error("port must be a number");
	}
	const port = Math.floor(value);
	if (port < 1 || port > 65_535) throw new Error("port must be between 1 and 65535");
	return port;
}

function protocolParam(value: unknown): "http" | "https" {
	if (value === undefined) return "https";
	if (value === "http" || value === "https") return value;
	throw new Error("protocol must be http or https");
}

export default definePlugin({
	name: "@parel/port-tools",
	version: "0.1.0",
	provides: { tools: true },
	requires: { capabilities: ["ports"] },

	async setup(ctx) {
		const ports = ctx.require<PortsCapability>("ports");

		ctx.tool(
			{
				name: "workspace_expose_port",
				description: "Expose a sandbox port and return its provider URL.",
				parameters: {
					type: "object",
					properties: {
						port: { type: "number", description: "Sandbox port number." },
						protocol: { type: "string", description: "URL protocol, http or https." },
					},
					required: ["port"],
				},
				scheduling: { defaultMode: "exclusive" },
			},
			async (params: PortParams): Promise<string> => {
				const handle = await ports.expose(portParam(params.port), {
					protocol: protocolParam(params.protocol),
				});
				return JSON.stringify(handle, null, 2);
			},
		);

		ctx.tool(
			{
				name: "workspace_list_ports",
				description: "List exposed sandbox ports for this session.",
				parameters: { type: "object", properties: {} },
				scheduling: { defaultMode: "parallel" },
			},
			async (): Promise<string> => JSON.stringify(await ports.list(), null, 2),
			{ scheduling: { defaultMode: "parallel" }, isConcurrencySafe: () => true },
		);

		ctx.tool(
			{
				name: "workspace_revoke_port",
				description: "Revoke a previously exposed sandbox port.",
				parameters: {
					type: "object",
					properties: {
						port: { type: "number", description: "Sandbox port number." },
					},
					required: ["port"],
				},
				scheduling: { defaultMode: "exclusive" },
			},
			async (params: PortParams): Promise<string> => {
				const port = portParam(params.port);
				const revoked = await ports.revoke(port);
				return revoked ? `Revoked port ${port}.` : `Port ${port} was not exposed.`;
			},
		);
	},
});
