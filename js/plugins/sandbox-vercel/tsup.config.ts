import { defineConfig } from "tsup";

export default defineConfig({
	entry: ["src/index.ts"],
	format: ["esm"],
	dts: true,
	noExternal: ["@parel/capability-sandbox"],
	clean: true,
	external: ["@vercel/sandbox"],
});
