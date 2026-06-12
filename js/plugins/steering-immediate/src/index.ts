import { definePlugin, LifecycleEvent, type ParelPlugin } from "@parel/plugin-sdk";
import manifest from "../parel.plugin.json" with { type: "json" };

export default definePlugin({
	name: "@parel/steering-immediate",
	execution: manifest.execution as ParelPlugin["execution"],

	async setup(ctx) {
		ctx.hook(LifecycleEvent.ContextBuild, async (hookCtx) => {
			const steers = hookCtx.inputs.drain("steer");
			if (steers.length === 0) return;

			return {
				action: "continue" as const,
				mutations: {
					messages: [
						...hookCtx.messages,
						...steers.map((steer) => ({
							role: "user" as const,
							parts: [
								{
									type: "text" as const,
									text: `[Steering] ${(steer.payload as { message: string }).message}`,
									visibility: "chat" as const,
								},
							],
						})),
					],
				},
			};
		});

		ctx.hook(LifecycleEvent.StepStart, async (hookCtx) => {
			const interrupts = hookCtx.inputs.peek("interrupt");
			if (interrupts.length > 0) {
				hookCtx.inputs.drain("interrupt");
				ctx.interrupt();
			}
		});
	},
});
