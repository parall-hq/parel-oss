import type { ParelPlugin, PluginContext } from "@parel/core";

interface PluginDefinition {
	name: string;
	/**
	 * Optional manifest version. The published `package.json` is the source of
	 * truth for a plugin's version; omit this and the SDK fills a placeholder so
	 * the in-source manifest can't drift from the package version.
	 */
	version?: string;
	provides?: ParelPlugin["provides"];
	requires?: ParelPlugin["requires"];
	execution?: ParelPlugin["execution"];
	setup(ctx: PluginContext): Promise<void>;
	teardown?(ctx: PluginContext): Promise<void>;
}

export function definePlugin(definition: PluginDefinition): ParelPlugin {
	return {
		name: definition.name,
		version: definition.version ?? "0.0.0",
		...(definition.provides ? { provides: definition.provides } : {}),
		...(definition.requires ? { requires: definition.requires } : {}),
		...(definition.execution ? { execution: definition.execution } : {}),
		setup: definition.setup,
		teardown: definition.teardown,
	};
}
