import optimizeLocales from "@react-aria/optimize-locales-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { docwalkTokens } from "./tooling/tokens-plugin.ts";

export default defineConfig({
  plugins: [
    react(),
    docwalkTokens(),
    // React Aria ships strings for 30+ locales; keep only the ones docwalk offers.
    { ...optimizeLocales.vite({ locales: ["en-US"] }), enforce: "pre" },
  ],
  build: {
    // Mermaid 12 targets ES2024 / Safari 17.4, which sets the floor (decision 31).
    target: ["es2024", "safari17.4"],
  },
});
