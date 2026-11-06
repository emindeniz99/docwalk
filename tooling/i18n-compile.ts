import { compile } from "@inlang/paraglide-js";
import { paraglideOptions } from "./paraglide.ts";

// `pnpm i18n`: writes src/paraglide/ for the typecheck. Vite and Vitest
// compile the same output through their plugin.
await compile(paraglideOptions);
