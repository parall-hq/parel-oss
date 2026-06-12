export function sessionWebSocketRequest(
	wsUrl: string,
	sessionId: string,
	token?: string,
): { url: string; protocols: string[] } {
	return {
		url: `${wsUrl}/sessions/${sessionId}/ws`,
		protocols: token ? ["parel-v1", `token.${token}`] : ["parel-v1"],
	};
}
