import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { firstLoadFilesContaining } from "./first-load.ts";

// Decision 43: size-limit fails the build above the hard limit in
// .size-limit.ts (1 MB); above WARN_BYTES it only warns, so growth is seen
// early without blocking work.
const WARN_BYTES = 500_000;

interface Result {
  name: string;
  size: number;
  passed: boolean;
}

let output: string;
let failed = false;
try {
  output = execFileSync("size-limit", ["--json"], { encoding: "utf8" });
} catch (error) {
  failed = true;
  output = String((error as { stdout?: unknown }).stdout ?? "[]");
}

for (const result of JSON.parse(output) as Result[]) {
  const kb = (result.size / 1000).toFixed(1);
  console.log(`${result.name}: ${kb} kB gzip${result.passed ? "" : " (over the hard limit)"}`);
  if (result.size > WARN_BYTES) {
    const message = `${result.name} is ${kb} kB gzip, over the ${WARN_BYTES / 1000} kB warning line`;
    console.log(process.env["GITHUB_ACTIONS"] ? `::warning::${message}` : `warning: ${message}`);
  }
}
// Decision 53: Monaco is opt-in and about 830 kB gzip. Its code in the first
// load would stay under the hard limit and still cost every visitor, so its
// presence fails on its own. `MonacoEnvironment` appears only in Monaco's code.
const leaked = firstLoadFilesContaining(join(import.meta.dirname, "../dist"), "MonacoEnvironment");
if (leaked.length > 0) {
  console.log(`Monaco reached the first load through ${leaked.join(", ")}; keep it behind lazy()`);
  failed = true;
}

process.exit(failed ? 1 : 0);
