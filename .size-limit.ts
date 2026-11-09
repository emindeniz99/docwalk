import { join } from "node:path";
import { firstLoadFiles } from "./tooling/first-load.ts";

// Decision 43: the app shell (JS + CSS, gzip -9) from the production build,
// before App's own lazy chunks. Run `pnpm build` first; `pnpm size` reads
// dist/. Hard limit here (5 MB, decision 124); tooling/size-check.ts warns above 3 MB. The full
// first load of the default view is checked by e2e/perf.spec.ts.
export default [
  {
    name: "App shell (JS + CSS)",
    path: firstLoadFiles(join(import.meta.dirname, "dist")).map((file) => `dist/${file}`),
    gzip: true,
    limit: "5 MB",
  },
];
