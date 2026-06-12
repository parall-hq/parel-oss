/**
 * Minimal PAREL runtime plugin.
 *
 * Registers a ContextBuild hook that appends an instruction to the system
 * prompt every time the context is built. This is illustrative — see
 * ../../protocol/plugins.md for the full hook and context API, and
 * ../../js/packages/plugin-sdk for the authoring helpers.
 */
import { definePlugin, LifecycleEvent } from "@parel/plugin-sdk";

export default definePlugin({
  name: "@example/concise-system-prompt",
  version: "0.1.0",
  async setup(ctx) {
    ctx.hook(LifecycleEvent.ContextBuild, async (hookCtx) => ({
      action: "continue",
      mutations: {
        system: hookCtx.system
          ? `${hookCtx.system}\n\nKeep answers concise.`
          : "Keep answers concise.",
      },
    }));
  },
});
