import optimizeLocales from "@react-aria/optimize-locales-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { docwalkCspMeta } from "./tooling/csp-plugin.ts";
import { docwalkExcalidrawAssets } from "./tooling/excalidraw-assets-plugin.ts";
import { docwalkTokens } from "./tooling/tokens-plugin.ts";

export default defineConfig({
  plugins: [
    react(),
    docwalkTokens(),
    // Static hosts ignore _headers; the built index.html carries the CSP itself (decision 34).
    docwalkCspMeta(),
    // Canvas mode's fonts come from this origin, never from a CDN (decisions 51, 54).
    docwalkExcalidrawAssets(),
    // React Aria ships strings for 30+ locales; keep only the ones docwalk offers.
    { ...optimizeLocales.vite({ locales: ["en-US"] }), enforce: "pre" },
  ],
  build: {
    // Mermaid 12 targets ES2024 / Safari 17.4, which sets the floor (decision 31).
    target: ["es2024", "safari17.4"],
  },
});
