import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

export interface SizeResult {
  name: string;
  size: number;
  passed: boolean;
}

/** The parts of `spawnSync`'s result that `runSizeLimit` reads. */
export interface SpawnResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

type Spawn = (command: string, args: string[]) => SpawnResult;

export interface SizeRun {
  results: SizeResult[];
  /** size-limit exited non-zero, which it does when a limit is missed. */
  overLimit: boolean;
}

/**
 * size-limit's entry script. Starting the `size-limit` command by name works
 * on macOS and Linux only: pnpm's shim on Windows is a `.cmd` file, which
 * Node refuses to start without a shell, and a shell only moves the problem
 * into argument quoting. Running the script with the Node that runs this one
 * is the same call everywhere.
 */
export function sizeLimitScript(): string {
  return join(dirname(createRequire(import.meta.url).resolve("size-limit")), "bin.js");
}

const spawnNode: Spawn = (command, args) => spawnSync(command, args, { encoding: "utf8" });

/**
 * Runs size-limit and returns its results. A missed limit is not an error:
 * the results are on stdout all the same. A run that printed no results (no
 * `dist/`, a broken config, no Node to start) throws with what size-limit
 * said, instead of looking like a missed limit with nothing to read.
 */
export function runSizeLimit(spawn: Spawn = spawnNode): SizeRun {
  const run = spawn(process.execPath, [sizeLimitScript(), "--json"]);
  if (run.error) throw new Error(`could not start size-limit: ${run.error.message}`);
  try {
    return { results: JSON.parse(run.stdout) as SizeResult[], overLimit: run.status !== 0 };
  } catch {
    const said = run.stderr || run.stdout;
    throw new Error(`size-limit exited with ${run.status} and printed no results.\n${said}`);
  }
}
