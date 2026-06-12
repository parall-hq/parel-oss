# @parel/capability-sandbox

> Provider-neutral PAREL sandbox capability contract.

This package defines the public TypeScript contract for plugins that provide or
consume an isolated execution environment. It does not implement a sandbox and
does not change PAREL's dynamic plugin dispatch: providers still call
`ctx.provide(PAREL_SANDBOX_CAPABILITY, impl)`, and consumers still call
`ctx.require<SandboxCapability>(PAREL_SANDBOX_CAPABILITY)`.

## Install

```bash
npm install @parel/capability-sandbox
```

## Usage

Provider plugin:

```ts
import {
	PAREL_SANDBOX_CAPABILITY,
	type SandboxCapability,
} from "@parel/capability-sandbox";

const sandbox: SandboxCapability = {
	provider: "example",
	process: {
		async exec(command) {
			return { stdout: "", stderr: "", exitCode: 0 };
		},
	},
};

ctx.provide(PAREL_SANDBOX_CAPABILITY, sandbox);
```

Consumer plugin:

```ts
import {
	PAREL_SANDBOX_CAPABILITY,
	type SandboxCapability,
} from "@parel/capability-sandbox";

const sandbox = ctx.require<SandboxCapability>(PAREL_SANDBOX_CAPABILITY);
const result = await sandbox.process?.exec(["python", "--version"]);
```

## Scope

This is a sandbox primitive contract: filesystem operations, command/process
execution, port exposure, and sandbox lifecycle. Workspace state, read digests,
touched files, coding-agent policy, and PAREL execution snapshots belong in
separate contracts.

## License

MIT — see [LICENSE](./LICENSE).
