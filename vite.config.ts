import { paraglideVitePlugin } from "@inlang/paraglide-js";
import optimizeLocales from "@react-aria/optimize-locales-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { docwalkCspMeta } from "./tooling/csp-plugin.ts";
import { docwalkExcalidrawAssets } from "./tooling/excalidraw-assets-plugin.ts";
import { paraglideOptions } from "./tooling/paraglide.ts";
import { docwalkPwa } from "./tooling/pwa-plugin.ts";
import { docwalkTokens } from "./tooling/tokens-plugin.ts";

export default defineConfig({
  plugins: [
    react(),
    docwalkTokens(),
    // UI strings in English and Turkish (decisions 30, 56), one module per message.
    paraglideVitePlugin(paraglideOptions),
    // Static hosts ignore _headers; the built index.html carries the CSP itself (decision 34).
    docwalkCspMeta(),
    // Canvas mode's fonts come from this origin, never from a CDN (decisions 51, 54).
    docwalkExcalidrawAssets(),
    // Installable and offline (decision 11): manifest, precache list, sw.js.
    docwalkPwa(),
    // React Aria ships strings for 30+ locales; keep only the ones docwalk offers
    // (src/i18n/locale.ts maps each UI locale to one of these).
    { ...optimizeLocales.vite({ locales: ["en-US", "tr-TR"] }), enforce: "pre" },
  ],
  // Shiki runs only in its worker (src/render/shiki.worker.ts), which the dependency scanner does
  // not follow: without these the dev server finds them at the first code block and reloads.
  optimizeDeps: {
    include: ["@shikijs/core", "@shikijs/engine-javascript", "@shikijs/primitive"],
  },
  build: {
    // Mermaid 12 targets ES2024 / Safari 17.4, which sets the floor (decision 31).
    target: ["es2024", "safari17.4"],
  },
});
