import { definePlugin, LifecycleEvent, type ParelPlugin } from "@parel/plugin-sdk";
import manifest from "../parel.plugin.json" with { type: "json" };

export default definePlugin({
	name: "@parel/budget-cap",
	execution: manifest.execution as ParelPlugin["execution"],

	async setup(ctx) {
		const maxUsd = (ctx.config.max_usd as number) ?? (ctx.config.daily as number) ?? 5;
		const maxTurns = (ctx.config.max_turns as number) ?? Infinity;

		ctx.hook(LifecycleEvent.ModelBefore, async (hookCtx) => {
			if (hookCtx.session.totalCostUsd >= maxUsd) {
				return {
					action: "stop" as const,
					reason: `Budget exceeded: $${hookCtx.session.totalCostUsd.toFixed(2)} >= $${maxUsd}`,
				};
			}
			if (hookCtx.session.turnCount > maxTurns) {
				return {
					action: "stop" as const,
					reason: `Turn limit reached: ${hookCtx.session.turnCount} > ${maxTurns}`,
				};
			}
		});
	},
});
