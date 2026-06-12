export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function getPath(input: unknown, path: string): unknown {
	let cur = input;
	for (const part of path.split(".")) {
		if (!part) continue;
		if (!isRecord(cur)) return undefined;
		cur = cur[part];
	}
	return cur;
}

export function stringAt(input: unknown, path: string): string | undefined {
	const value = getPath(input, path);
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	return undefined;
}

export function numberAt(input: unknown, path: string): number | undefined {
	const value = getPath(input, path);
	return typeof value === "number" ? value : undefined;
}

export function timingSafeEqualString(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}
