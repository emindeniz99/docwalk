import { spawnSync } from "node:child_process";
import { describe, expect, test } from "vitest";
import { runSizeLimit, sizeLimitScript, type SpawnResult } from "./size-limit-run.ts";

const spawned = (result: Partial<SpawnResult>) => (): SpawnResult => ({
  status: 0,
  stdout: "",
  stderr: "",
  ...result,
});

describe("starting size-limit (pnpm size)", () => {
  // The `size-limit` that pnpm puts on the path is a .cmd shim on Windows,
  // which Node cannot start without a shell: `pnpm size` exited 1 and printed
  // nothing. Node running size-limit's own script starts the same way on
  // every platform.
  test("runs size-limit's entry script with the current Node, with no shim and no shell", () => {
    const run = spawnSync(process.execPath, [sizeLimitScript(), "--help"], { encoding: "utf8" });
    expect({ error: run.error?.message, status: run.status }).toEqual({
      error: undefined,
      status: 0,
    });
    expect(run.stdout).toMatch(/size-limit/i);
  });

  test("hands back the results and says the limit was missed when size-limit exits non-zero", () => {
    const json = JSON.stringify([{ name: "App", size: 1_100_000, passed: false }]);
    expect(runSizeLimit(spawned({ stdout: json, status: 1 }))).toEqual({
      results: [{ name: "App", size: 1_100_000, passed: false }],
      overLimit: true,
    });
    expect(runSizeLimit(spawned({ stdout: json, status: 0 })).overLimit).toBe(false);
  });

  // A run that prints no results (no dist/, a broken config) used to read as
  // "[]" and end in a bare exit 1; the reason has to reach the terminal.
  test("reports size-limit's own message when it prints no results", () => {
    expect(() =>
      runSizeLimit(spawned({ status: 1, stderr: "Can't find files for dist/missing.js" })),
    ).toThrow(/exited with 1.*Can't find files for dist\/missing\.js/s);
  });

  test("reports why size-limit could not be started at all", () => {
    expect(() =>
      runSizeLimit(spawned({ status: null, error: new Error("spawn node ENOENT") })),
    ).toThrow(/could not start size-limit.*spawn node ENOENT/s);
  });
});
