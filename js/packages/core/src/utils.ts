import type {
	Message,
	MessagePart,
	MessagePartVisibility,
	ProviderArtifact,
	ReasoningPart,
	TextPart,
	ToolCall,
	ToolCallPart,
	ToolResultPart,
} from "./types/session.js";

export function textContent(content: string | MessagePart[] | Message): string {
	if (typeof content === "string") return content;
	const parts = Array.isArray(content) ? content : content.parts;
	return parts
		.filter((p): p is TextPart => p.type === "text")
		.map((p) => p.text)
		.join("");
}

export function reasoningContent(message: Message): string {
	return message.parts
		.filter((p): p is ReasoningPart => p.type === "reasoning")
		.map((p) => p.summary ?? p.text ?? "")
		.join("");
}

export function messageToolCalls(message: Message): ToolCall[] {
	return message.parts
		.filter((p): p is ToolCallPart => p.type === "tool_call")
		.map((p) => p.toolCall);
}

export function messageToolResults(message: Message): ToolResultPart[] {
	return message.parts.filter((p): p is ToolResultPart => p.type === "tool_result");
}

export function visibleText(message: Message, visibility?: MessagePartVisibility): string {
	return message.parts
		.filter((p) => {
			if (!visibility) return p.visibility !== "hidden";
			return p.visibility === visibility || (visibility === "chat" && p.visibility === undefined);
		})
		.map((p) => {
			if (p.type === "text") return p.text;
			if (p.type === "reasoning") return p.summary ?? p.text ?? "";
			if (p.type === "tool_result") return p.content;
			return "";
		})
		.filter(Boolean)
		.join("");
}

export function findProviderArtifact(
	part: MessagePart,
	provider: string,
	artifactType: string,
): ProviderArtifact | undefined {
	return part.providerArtifacts?.find(
		(artifact) => artifact.provider === provider && artifact.artifactType === artifactType,
	);
}
