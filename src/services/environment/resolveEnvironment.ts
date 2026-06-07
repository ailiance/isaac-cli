import { LocalEnvironment } from "./LocalEnvironment"
import type { CommandRunner, Environment } from "./types"

export interface ResolveEnvironmentOptions {
	cwd: string
	commandRunner?: CommandRunner
}

export function resolveEnvironment(opts: ResolveEnvironmentOptions): Environment {
	return new LocalEnvironment(opts.cwd, opts.commandRunner)
}
