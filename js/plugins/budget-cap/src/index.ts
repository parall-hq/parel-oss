import { definePlugin, LifecycleEvent, type ParelPlugin } from "@parel/plugin-sdk";
import manifest from "../parel.plugin.json" with { type: "json" };

/** Store key: the "no price" warning was logged for this session. */
const UNPRICED_WARNED = "unpriced-warned";

export default definePlugin({
	name: "@parel/budget-cap",
	execution: manifest.execution as ParelPlugin["execution"],

	async setup(ctx) {
		const maxUsd = (ctx.config.max_usd as number) ?? (ctx.config.daily as number) ?? 5;
		const maxTurns = (ctx.config.max_turns as number) ?? Infinity;

		ctx.hook(LifecycleEvent.ModelBefore, async (hookCtx) => {
			const { totalCostUsd, totalTokens, turnCount } = hookCtx.session;
			if (totalCostUsd >= maxUsd) {
				return {
					action: "stop" as const,
					reason: `Budget exceeded: $${totalCostUsd.toFixed(2)} >= $${maxUsd}`,
				};
			}
			if (turnCount > maxTurns) {
				return {
					action: "stop" as const,
					reason: `Turn limit reached: ${turnCount} > ${maxTurns}`,
				};
			}
			// Tokens but no cost means the model has no price (an unpriced model on
			// your own key): the cost never grows, so max_usd can never stop the session.
			if (totalTokens > 0 && totalCostUsd === 0 && !(await ctx.store.get(UNPRICED_WARNED))) {
				await ctx.store.set(UNPRICED_WARNED, true);
				ctx.log.warn(
					`Session used ${totalTokens} tokens at $0: the model has no price, so max_usd ($${maxUsd}) cannot take effect.`,
				);
			}
		});
	},
});
