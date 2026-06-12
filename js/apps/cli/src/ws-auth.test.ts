import { describe, expect, it } from "vitest";
import { sessionWebSocketRequest } from "./ws-auth.js";

describe("sessionWebSocketRequest", () => {
	it("sends credentials as WebSocket subprotocols", () => {
		const request = sessionWebSocketRequest("wss://api.parel.sh", "ssn_123", "pk_test");

		expect(request.url).toBe("wss://api.parel.sh/sessions/ssn_123/ws");
		expect(request.url).not.toContain("token=");
		expect(request.protocols).toEqual(["parel-v1", "token.pk_test"]);
	});

	it("omits the token protocol when no credential is available", () => {
		const request = sessionWebSocketRequest("ws://localhost:8787", "ssn_local");

		expect(request.url).toBe("ws://localhost:8787/sessions/ssn_local/ws");
		expect(request.protocols).toEqual(["parel-v1"]);
	});
});
