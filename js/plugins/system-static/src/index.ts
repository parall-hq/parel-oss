import { definePlugin, LifecycleEvent, type ParelPlugin } from "@parel/plugin-sdk";
import manifest from "../parel.plugin.json" with { type: "json" };

export default definePlugin({
	name: "@parel/system-static",
	execution: manifest.execution as ParelPlugin["execution"],

	async setup(ctx) {
		const prompt = ctx.config.prompt as string;
		if (!prompt) return;

		ctx.hook(
			LifecycleEvent.ContextBuild,
			async (hookCtx) => {
				return {
					action: "continue" as const,
					mutations: {
						system: hookCtx.system ? `${hookCtx.system}\n\n${prompt}` : prompt,
					},
				};
			},
			{ priority: 10 },
		);
	},
});
