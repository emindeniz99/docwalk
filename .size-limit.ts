import { join } from "node:path";
import { firstLoadFiles } from "./tooling/first-load.ts";

// Decision 43: the main view's first load (JS + CSS, gzip -9) from the
// production build. Run `pnpm build` first; `pnpm size` reads dist/.
export default [
  {
    name: "First load (JS + CSS)",
    path: firstLoadFiles(join(import.meta.dirname, "dist")).map((file) => `dist/${file}`),
    gzip: true,
    limit: "295 kB",
  },
];
