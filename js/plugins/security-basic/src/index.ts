import { definePlugin, HookPriority, LifecycleEvent, type ParelPlugin } from "@parel/plugin-sdk";
import manifest from "../parel.plugin.json" with { type: "json" };

const DEFAULT_EXEC_TOOLS = new Set([
	"bash",
	"shell",
	"exec",
	"terminal",
	"run_command",
	"run",
	"workspace_shell",
	"workspace_start_process",
]);

const DEFAULT_ALLOWED_PATTERNS = [
	/^(ls|cat|head|tail|wc|grep|find|which|echo|printf|date|pwd|whoami|id|env|printenv)$/,
	/^(cd|mkdir|cp|mv|touch|ln)$/,
	/^(node|npx|npm|pnpm|bun|deno|python|python3|pip|pip3)$/,
	/^(git|gh)$/,
	/^(curl|wget|dig|nslookup|ping)$/,
	/^(jq|yq|sed|awk|sort|uniq|cut|tr|xargs|tee)$/,
	/^(docker|podman|kubectl)$/,
	/^(make|cargo|go|rustc|gcc|g\+\+|javac|java|dotnet)$/,
	/^(tar|zip|unzip|gzip|gunzip)$/,
	/^(vi|vim|nano|less|more|diff|patch)$/,
	/^(test|\[|true|false|read|set|export|source|\.)$/,
];

const DENY_PATTERNS = [
	/\brm\s+(-[a-z]*r[a-z]*\s+(-[a-z]*f|\/)|(-[a-z]*f[a-z]*\s+(-[a-z]*r|\/))|-rf\s)/,
	/\brm\s+(-[a-z]*f[a-z]*\s+)?\/($|\s)/,
	/\bmkfs\b/,
	/\bdd\b.*\bof=\/dev\//,
	/>\s*\/dev\/sd[a-z]/,
	/\bchmod\b.*\b777\b.*\//,
	/\bchown\b.*-R\b.*\//,
	/\b(shutdown|reboot|halt|poweroff|init\s+[06])\b/,
	/\bwipefs\b/,
	/\bshred\b.*\//,
];

function createSecretPatterns(): RegExp[] {
	return [
		/sk-[a-zA-Z0-9]{20,}/g,
		/sk-ant-[a-zA-Z0-9-]{20,}/g,
		/ghp_[a-zA-Z0-9]{36,}/g,
		/gho_[a-zA-Z0-9]{36,}/g,
		/github_pat_[a-zA-Z0-9_]{20,}/g,
		/AKIA[A-Z0-9]{16}/g,
		/-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g,
		/xoxb-[a-zA-Z0-9-]+/g,
		/xoxp-[a-zA-Z0-9-]+/g,
		/sk_live_[a-zA-Z0-9]+/g,
		/pk_live_[a-zA-Z0-9]+/g,
		/(?<=^|[^a-zA-Z0-9])pk_[a-zA-Z0-9]{24,}/g,
		/eyJ[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]{20,}/g,
	];
}

function redactSecrets(text: string): string {
	for (const pattern of createSecretPatterns()) {
		text = text.replace(pattern, "[REDACTED]");
	}
	return text;
}

// Strips backslash escapes and quotes so obfuscated destructive commands
// (e.g. 'rm' -rf /, rm -r''f /, chmod 7"7"7 /) still match DENY_PATTERNS even in
// non-allowlist modes where the deny list is the only guard.
function normalizeForDeny(cmd: string): string {
	return cmd.replace(/\\(.)/g, "$1").replace(/['"]/g, "").replace(/\s+/g, " ");
}

// Command wrappers whose first non-flag argument is itself a program to run.
// We skip the wrapper and require the wrapped program to be allowlisted too.
const COMMAND_WRAPPERS = new Set([
	"sudo",
	"env",
	"nohup",
	"time",
	"command",
	"builtin",
	"exec",
	"nice",
	"ionice",
	"setsid",
	"stdbuf",
	"xargs",
	"watch",
	"timeout",
]);

// Operators that introduce a new command, so the next word is a program position.
const COMMAND_SEPARATORS = new Set(["|", "||", "&&", ";", "&", "|&", "\n"]);

/**
 * Tokenizes a shell command into a flat token stream while expanding any
 * command substitutions (`$(...)`, backticks) and process substitutions
 * (`<(...)`, `>(...)`) into their own nested token streams.
 *
 * The goal is NOT to be a faithful shell parser, but to conservatively surface
 * every place a program name can appear so the allowlist cannot be bypassed by
 * hiding a disallowed program inside quotes, substitutions, or pipelines.
 */
interface Token {
	value: string;
	/** True when this token is a control operator (separator/redirection). */
	operator: boolean;
	/** Nested token streams discovered inside this token (substitutions). */
	nested: Token[][];
}

type CharClass = "normal" | "single" | "double";

function tokenize(input: string): Token[] {
	const tokens: Token[] = [];
	let i = 0;
	const n = input.length;

	// Accumulator for the current word and any nested substitution streams.
	let current = "";
	let currentNested: Token[][] = [];
	let hasWord = false;

	const pushWord = () => {
		if (hasWord) {
			tokens.push({ value: current, operator: false, nested: currentNested });
			current = "";
			currentNested = [];
			hasWord = false;
		}
	};

	const pushOperator = (op: string) => {
		pushWord();
		tokens.push({ value: op, operator: true, nested: [] });
	};

	// Reads a balanced block until `close`, honoring quoting and nesting, and
	// returns the inner text plus the index past the closing delimiter.
	const readBalanced = (start: number, open: string, close: string): [string, number] => {
		let depth = 1;
		let j = start;
		let quote: CharClass = "normal";
		while (j < n) {
			const c = input[j];
			if (quote === "single") {
				if (c === "'") quote = "normal";
				j++;
				continue;
			}
			if (quote === "double") {
				if (c === "\\") {
					j += 2;
					continue;
				}
				if (c === '"') quote = "normal";
				j++;
				continue;
			}
			if (c === "'") {
				quote = "single";
				j++;
				continue;
			}
			if (c === '"') {
				quote = "double";
				j++;
				continue;
			}
			if (c === "\\") {
				j += 2;
				continue;
			}
			if (open && c === open) {
				depth++;
				j++;
				continue;
			}
			if (c === close) {
				depth--;
				if (depth === 0) {
					return [input.slice(start, j), j + 1];
				}
				j++;
				continue;
			}
			j++;
		}
		// Unterminated: treat the rest as inner content (conservative).
		return [input.slice(start), n];
	};

	const addNested = (inner: string) => {
		currentNested.push(tokenize(inner));
		// Mark this word as present so substitutions standing alone (e.g.
		// `$(cmd)` as the program) still count as a parsed token.
		hasWord = true;
	};

	while (i < n) {
		const c = input[i];

		// --- single quotes: literal, no expansion ---
		if (c === "'") {
			const [inner, next] = readBalanced(i + 1, "", "'");
			current += inner;
			hasWord = true;
			i = next;
			continue;
		}

		// --- double quotes: expansions still apply inside ---
		if (c === '"') {
			let j = i + 1;
			while (j < n) {
				const d = input[j];
				if (d === "\\") {
					if (j + 1 < n) current += input[j + 1];
					j += 2;
					continue;
				}
				if (d === '"') {
					j++;
					break;
				}
				if (d === "`") {
					const [inner, next] = readBalanced(j + 1, "", "`");
					addNested(inner);
					j = next;
					continue;
				}
				if (d === "$" && input[j + 1] === "(") {
					const [inner, next] = readBalanced(j + 2, "(", ")");
					addNested(inner);
					j = next;
					continue;
				}
				current += d;
				hasWord = true;
				j++;
			}
			hasWord = true;
			i = j;
			continue;
		}

		// --- backtick command substitution ---
		if (c === "`") {
			const [inner, next] = readBalanced(i + 1, "", "`");
			addNested(inner);
			i = next;
			continue;
		}

		// --- $(...) command substitution and ${...} parameter expansion ---
		if (c === "$" && input[i + 1] === "(") {
			// $(( ... )) arithmetic is not itself a command, but it may still
			// contain command substitutions (`$(( $(cmd) + 0 ))`) that DO run
			// programs. Surface only those nested substitutions for validation —
			// never the arithmetic operands/operators, which are not programs.
			if (input[i + 2] === "(") {
				const [arith, next] = readBalanced(i + 3, "(", ")");
				for (const tok of tokenize(arith)) {
					for (const sub of tok.nested) currentNested.push(sub);
				}
				hasWord = true;
				// Consume a possible trailing ")" of the arithmetic expansion.
				i = input[next] === ")" ? next + 1 : next;
				continue;
			}
			const [inner, next] = readBalanced(i + 2, "(", ")");
			addNested(inner);
			i = next;
			continue;
		}

		// --- process substitution <(...) >(...) ---
		if ((c === "<" || c === ">") && input[i + 1] === "(") {
			const [inner, next] = readBalanced(i + 2, "(", ")");
			addNested(inner);
			i = next;
			continue;
		}

		// --- whitespace ---
		if (c === " " || c === "\t") {
			pushWord();
			i++;
			continue;
		}
		if (c === "\n") {
			pushOperator("\n");
			i++;
			continue;
		}

		// --- grouping with subshell / brace blocks ---
		if (c === "(") {
			const [inner, next] = readBalanced(i + 1, "(", ")");
			// A subshell runs its own commands — recurse and splice tokens in.
			pushWord();
			const innerTokens = tokenize(inner);
			tokens.push({ value: "(", operator: true, nested: [] });
			for (const t of innerTokens) tokens.push(t);
			tokens.push({ value: ")", operator: true, nested: [] });
			i = next;
			continue;
		}

		// --- separators / operators ---
		const two = input.slice(i, i + 2);
		if (two === "&&" || two === "||" || two === "|&") {
			pushOperator(two);
			i += 2;
			continue;
		}
		if (c === "|" || c === ";" || c === "&") {
			pushOperator(c);
			i++;
			continue;
		}

		// --- redirections: mark operator so following word is a file, not a prog ---
		if (c === ">" || c === "<") {
			// Optional fd prefix like 2> is part of the previous word number; we
			// just emit a redirection operator and let the next word be a target.
			let op = c;
			if (input[i + 1] === ">") {
				op += ">";
				i++;
			}
			// fd-duplication: >&, >>&, <& (e.g. `2>&1`) — keep the `&` as part of the
			// redirection operator so the trailing fd is a target, not a separator/program.
			if (input[i + 1] === "&") {
				op += "&";
				i++;
			}
			pushOperator(op);
			i++;
			continue;
		}

		// --- escaped char outside quotes ---
		if (c === "\\") {
			if (i + 1 < n) {
				current += input[i + 1];
				hasWord = true;
			}
			i += 2;
			continue;
		}

		// --- ordinary character ---
		current += c;
		hasWord = true;
		i++;
	}

	pushWord();
	return tokens;
}

/**
 * Walks a token stream and collects every program-position word, recursing into
 * nested substitutions. A program position is the first word of the command, of
 * any command after a separator, and inside subshell groups — after skipping
 * `VAR=val` assignment prefixes and recognized command wrappers.
 *
 * Redirection targets are excluded (they are files, not programs).
 */
function collectPrograms(tokens: Token[], out: string[]): void {
	let expectProgram = true; // start of stream is a command position
	let afterRedirection = false;
	let inWrapperArgs = false; // skipping a wrapper's own flags/operands until its wrapped program

	for (const token of tokens) {
		// Always recurse into nested substitutions regardless of position: an
		// allowed outer program must never smuggle a disallowed inner one.
		for (const nested of token.nested) {
			collectPrograms(nested, out);
		}

		if (token.operator) {
			if (token.value === "(") {
				expectProgram = true;
				afterRedirection = false;
				inWrapperArgs = false;
				continue;
			}
			if (token.value === ")") {
				expectProgram = false;
				afterRedirection = false;
				inWrapperArgs = false;
				continue;
			}
			// Any redirection operator (>, >>, <, >&, >>&, <&) — the next word is a target.
			if (token.value[0] === ">" || token.value[0] === "<") {
				afterRedirection = true;
				continue;
			}
			if (COMMAND_SEPARATORS.has(token.value)) {
				expectProgram = true;
				afterRedirection = false;
				inWrapperArgs = false;
				continue;
			}
			continue;
		}

		// A word following a redirection operator is a filename target.
		if (afterRedirection) {
			afterRedirection = false;
			continue;
		}

		if (!expectProgram) continue;

		// Skip leading `VAR=value` assignment prefixes; the program is the next
		// non-assignment word in this command position.
		if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token.value)) {
			continue;
		}

		// Inside a wrapper's argument list, skip the wrapper's own option flags and
		// numeric operands (e.g. `env -i`, `timeout 5`, `xargs -n1`) so the wrapped
		// program — not a flag — is what gets validated next.
		if (inWrapperArgs && (token.value.startsWith("-") || /^\d+$/.test(token.value))) {
			continue;
		}

		// A command/process substitution in PROGRAM position makes the resolved
		// program name unknowable statically: `$(echo rm) -rf /` expands to
		// `rm -rf /`, and `pre$(cmd)` becomes whatever the substitution prints.
		// The inner programs were already validated via nested recursion above,
		// but we must additionally refuse the outer position — in allowlist mode
		// we cannot prove the produced program is permitted. Emit a sentinel that
		// no allow pattern matches so the command is blocked.
		if (token.nested.length > 0) {
			out.push("$(...)");
			expectProgram = false;
			inWrapperArgs = false;
			continue;
		}

		// Resolve the program word, unwrapping command wrappers (sudo/env/...).
		const program = basename(token.value);
		if (COMMAND_WRAPPERS.has(program)) {
			// Stay in program-expect state so the wrapped command is validated,
			// but record the wrapper itself so it must also be allowed/known.
			out.push(program);
			expectProgram = true;
			inWrapperArgs = true;
			afterRedirection = false;
			continue;
		}

		out.push(program);
		expectProgram = false;
		inWrapperArgs = false;
	}
}

/** Strips a path prefix so `/usr/bin/curl` and `./foo` resolve to a basename. */
function basename(word: string): string {
	const slash = word.lastIndexOf("/");
	return slash >= 0 ? word.slice(slash + 1) : word;
}

/**
 * Extracts every program-position word from a raw command string, including
 * those hidden inside command/process substitutions, backticks, subshells, and
 * pipelines. Returns an empty list only for an empty command.
 */
function extractAllPrograms(command: string): string[] {
	const tokens = tokenize(command);
	const out: string[] = [];
	collectPrograms(tokens, out);
	return out;
}

export default definePlugin({
	name: "@parel/security-basic",
	execution: manifest.execution as ParelPlugin["execution"],

	async setup(ctx) {
		const mode = (ctx.config.mode as string) ?? "allowlist";
		const customExecTools = ctx.config.exec_tools as string[] | undefined;
		const execTools = customExecTools ? new Set(customExecTools) : DEFAULT_EXEC_TOOLS;

		const customAllowed = ctx.config.allowed_patterns as string[] | undefined;
		const allowedPatterns = customAllowed
			? customAllowed.map((p) => new RegExp(p))
			: DEFAULT_ALLOWED_PATTERNS;

		ctx.hook(
			LifecycleEvent.ToolBefore,
			async (hookCtx) => {
				if (!execTools.has(hookCtx.toolCall.name)) return;
				const command = hookCtx.toolCall.arguments.command as string;
				if (!command) return;

				const denyTargets = [command, normalizeForDeny(command)];
				for (const pattern of DENY_PATTERNS) {
					if (denyTargets.some((target) => pattern.test(target))) {
						return {
							action: "block" as const,
							reason: `Blocked: destructive command pattern detected`,
						};
					}
				}

				if (mode === "allowlist") {
					const programs = extractAllPrograms(command);
					for (const prog of programs) {
						const allowed = allowedPatterns.some((p) => p.test(prog));
						if (!allowed) {
							return {
								action: "block" as const,
								reason: `Blocked: "${prog}" is not in the allowed command list`,
							};
						}
					}
				}
			},
			{ priority: HookPriority.Security },
		);

		ctx.hook(
			LifecycleEvent.ToolAfter,
			async (hookCtx) => {
				const content = hookCtx.toolResult.content;
				if (typeof content !== "string") return;
				const redacted = redactSecrets(content);
				if (redacted !== content) {
					return {
						action: "continue" as const,
						mutations: { toolResult: { ...hookCtx.toolResult, content: redacted } },
					};
				}
			},
			{ priority: HookPriority.Security },
		);

		ctx.hook(
			LifecycleEvent.ContextBuild,
			async (hookCtx) => {
				const system = redactSecrets(hookCtx.system);

				const messages = hookCtx.messages.map((msg) => {
					const parts = msg.parts.map((part) => {
						if (part.type === "text") {
							const text = redactSecrets(part.text);
							return text !== part.text ? { ...part, text } : part;
						}
						return part;
					});
					return { ...msg, parts };
				});

				return {
					action: "continue" as const,
					mutations: { system, messages },
				};
			},
			{ priority: HookPriority.Late },
		);
	},
});
