import { join } from "node:path";
import type { CompilerOptions } from "@inlang/paraglide-js";

const root = join(import.meta.dirname, "..");

/**
 * One set of Paraglide compiler options (decisions 30, 56) for the Vite and
 * Vitest plugins and for `pnpm i18n`, which compiles before the typecheck
 * (tsc needs the generated `src/paraglide/` and the folder is not committed).
 *
 * The ICU plugin is loaded from node_modules (project.inlang/settings.json),
 * not from a CDN: the build makes no outbound call and the plugin version is
 * the pinned, age-checked one in the lockfile.
 *
 * The app owns locale choice (`src/i18n/locale.ts`: stored choice, then
 * navigator.languages, then English) and hands Paraglide the result, so the
 * runtime only needs its global variable; the other strategies tree-shake away.
 */
export const paraglideOptions = {
  project: join(root, "project.inlang"),
  outdir: join(root, "src/paraglide"),
  strategy: ["globalVariable", "baseLocale"],
  emitReadme: false,
} satisfies CompilerOptions;
