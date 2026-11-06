import { readFileSync } from "node:fs";
import { defineConfig } from "vite";

// Node refuses to strip TypeScript under node_modules, so an installed bin
// must be JavaScript, or every registry install crashes on start. This
// bundles the server with the room code it shares with the app
// (../src/remote) into one ES module and leaves the npm dependencies to the
// installer.
const pkg = JSON.parse(readFileSync(new URL("package.json", import.meta.url), "utf8")) as {
  dependencies: Record<string, string>;
};
const external = Object.keys(pkg.dependencies);

export default defineConfig({
  root: import.meta.dirname,
  logLevel: "warn",
  build: {
    ssr: "src/index.ts",
    outDir: "dist",
    emptyOutDir: true,
    target: "node22",
    minify: false,
    sourcemap: false,
    rolldownOptions: {
      external: (id) => external.some((dep) => id === dep || id.startsWith(`${dep}/`)),
      output: {
        format: "es",
        entryFileNames: "docwalk-mcp.js",
        banner: "#!/usr/bin/env node",
      },
    },
  },
});
