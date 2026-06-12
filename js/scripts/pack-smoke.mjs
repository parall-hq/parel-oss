import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspaceRoots = ["packages", "capabilities", "plugins", "apps"];
const tempRoot = mkdtempSync(join(tmpdir(), "parel-pack-smoke-"));
const packDir = join(tempRoot, "packs");
const installDir = join(tempRoot, "install");

function readJson(path) {
	return JSON.parse(readFileSync(path, "utf8"));
}

function packageInstallDir(packageName) {
	const parts = packageName.split("/");
	return join(installDir, "node_modules", ...parts);
}

function run(command, args, options = {}) {
	return execFileSync(command, args, {
		cwd: options.cwd ?? root,
		encoding: "utf8",
		stdio: options.stdio ?? ["ignore", "pipe", "inherit"],
	});
}

function workspacePackages() {
	const packages = [];
	for (const workspaceRoot of workspaceRoots) {
		const absoluteRoot = join(root, workspaceRoot);
		if (!existsSync(absoluteRoot)) continue;
		for (const entry of readdirSync(absoluteRoot)) {
			const dir = join(absoluteRoot, entry);
			if (!statSync(dir).isDirectory()) continue;
			const packageJsonPath = join(dir, "package.json");
			if (!existsSync(packageJsonPath)) continue;
			const packageJson = readJson(packageJsonPath);
			if (packageJson.private) continue;
			packages.push({ dir, packageJson });
		}
	}
	return packages.sort((a, b) => a.packageJson.name.localeCompare(b.packageJson.name));
}

function assertFile(path, label) {
	if (!existsSync(path)) throw new Error(`${label} is missing: ${path}`);
}

function assertPublishedFiles(pkg) {
	const installed = packageInstallDir(pkg.name);
	const installedPackageJson = readJson(join(installed, "package.json"));

	if (installedPackageJson.exports?.["."]?.import) {
		assertFile(
			join(installed, installedPackageJson.exports["."].import),
			`${pkg.name} import export`,
		);
	}
	if (installedPackageJson.exports?.["."]?.types) {
		assertFile(join(installed, installedPackageJson.exports["."].types), `${pkg.name} type export`);
	}
	if (installedPackageJson.bin) {
		for (const [binName, binPath] of Object.entries(installedPackageJson.bin)) {
			assertFile(join(installed, binPath), `${pkg.name} bin ${binName}`);
		}
	}
}

try {
	mkdirSync(packDir, { recursive: true });
	mkdirSync(installDir, { recursive: true });

	const packages = workspacePackages();
	if (packages.length === 0) throw new Error("No public workspace packages found.");

	console.log(`Packing ${packages.length} public packages...`);
	for (const { dir, packageJson } of packages) {
		console.log(`- ${packageJson.name}`);
		run("pnpm", ["--dir", dir, "pack", "--pack-destination", packDir], { stdio: "inherit" });
	}

	const tarballs = readdirSync(packDir)
		.filter((file) => file.endsWith(".tgz"))
		.map((file) => join(packDir, file))
		.sort();
	if (tarballs.length !== packages.length) {
		throw new Error(`Expected ${packages.length} tarballs, found ${tarballs.length}.`);
	}

	writeFileSync(
		join(installDir, "package.json"),
		JSON.stringify({ private: true, type: "module" }, null, 2),
	);

	console.log("Installing packed tarballs into a temporary project...");
	run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", ...tarballs], {
		cwd: installDir,
		stdio: "inherit",
	});

	for (const { packageJson } of packages) assertPublishedFiles(packageJson);

	console.log("Checking representative package imports...");
	run(
		process.execPath,
		[
			"--input-type=module",
			"--eval",
			[
				'await import("@parel/core");',
				'await import("@parel/plugin-sdk");',
				'await import("@parel/capability-sandbox");',
				'await import("@parel/system-static");',
				'await import("@parel/security-basic");',
			].join("\n"),
		],
		{ cwd: installDir, stdio: "inherit" },
	);

	console.log("Checking CLI startup...");
	run(process.execPath, [join(packageInstallDir("@parel/cli"), "dist/index.js"), "--help"], {
		cwd: installDir,
		stdio: "inherit",
	});

	console.log("Pack smoke test passed.");
} finally {
	if (process.env.PAREL_KEEP_PACK_SMOKE !== "1") rmSync(tempRoot, { recursive: true, force: true });
}
