import { createReadStream, readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, sep } from "node:path";
import type { Plugin } from "vite";

/**
 * Where the build serves Excalidraw's fonts. Canvas mode sets
 * `window.EXCALIDRAW_ASSET_PATH` to this folder (src/canvas/assets.ts).
 */
export const EXCALIDRAW_ASSET_DIR = "excalidraw-assets";

/** `node_modules/@excalidraw/excalidraw/dist/prod`, where the package keeps its fonts. */
export function excalidrawDistDir(): string {
  const require = createRequire(import.meta.url);
  // The package exports only its entry and CSS; resolve the entry and walk to its folder.
  return dirname(require.resolve("@excalidraw/excalidraw"));
}

/** Every font file under `dist/prod/fonts`, as a path relative to `dist/prod` with forward slashes. */
export function excalidrawFontFiles(dist: string = excalidrawDistDir()): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else files.push(relative(dist, path).split(sep).join("/"));
    }
  };
  walk(join(dist, "fonts"));
  return files.toSorted();
}

const FONT_TYPES: Record<string, string> = {
  woff2: "font/woff2",
  woff: "font/woff",
  ttf: "font/ttf",
};

/**
 * Excalidraw 0.18 lists esm.sh after `EXCALIDRAW_ASSET_PATH` as a second
 * source of every font (`ExcalidrawFontFace.ASSETS_FALLBACK_URL`). Chrome
 * checks every source of a `FontFace` against the CSP when it is created,
 * so each sketch logged ~230 blocked third-party font loads even though the
 * fonts came from this origin. The fallback is rewritten to this origin too.
 */
// The literal nests another template literal for the package name, so match lazily up to its end.
const FALLBACK_URL = /`https:\/\/esm\.sh\/\$\{[^\n]*?\}\/dist\/prod\/`/g;

/** Replaces Excalidraw's esm.sh font fallback with `assetBase` on this origin; throws unless there is exactly one. */
export function rewriteFontFallback(code: string, assetBase: string): string {
  const found = code.match(FALLBACK_URL)?.length ?? 0;
  if (found !== 1) {
    throw new Error(
      `docwalk-excalidraw-assets: expected one esm.sh font fallback in Excalidraw, found ${found}. ` +
        "Excalidraw changed; check that its fonts still load only from this origin (e2e/canvas.spec.ts).",
    );
  }
  return code.replace(FALLBACK_URL, `(location.origin + ${JSON.stringify(assetBase)})`);
}

/**
 * Self-hosts Excalidraw's fonts (decision 51). Excalidraw loads its
 * hand-drawn fonts from `EXCALIDRAW_ASSET_PATH`, and from esm.sh when that
 * is unset or fails; esm.sh would see every visitor who opens a sketch. The
 * build copies the package's `fonts/` folder to `/excalidraw-assets/fonts/`
 * and the dev server serves the same paths from `node_modules`. Fonts named
 * in Excalidraw's CSS are bundled by Vite as usual.
 */
export function docwalkExcalidrawAssets(): Plugin {
  const dist = excalidrawDistDir();
  let assetBase = `/${EXCALIDRAW_ASSET_DIR}/`;
  let build = false;
  let sawExcalidraw = false;
  let rewritten = 0;
  return {
    name: "docwalk-excalidraw-assets",
    configResolved(config) {
      assetBase = `${config.base}${EXCALIDRAW_ASSET_DIR}/`;
      build = config.command === "build";
    },
    transform(code, id) {
      // Dev serves pre-bundled deps without this hook, and has no CSP to trip.
      if (!build || !id.includes("/@excalidraw/excalidraw/dist/")) return undefined;
      sawExcalidraw = true;
      if (!code.includes("https://esm.sh/")) return undefined;
      rewritten++;
      return { code: rewriteFontFallback(code, assetBase), map: null };
    },
    configureServer(server) {
      const prefix = `/${EXCALIDRAW_ASSET_DIR}/`;
      const known = new Set(excalidrawFontFiles(dist));
      server.middlewares.use((req, res, next) => {
        const path = decodeURIComponent((req.url ?? "").split("?")[0] ?? "");
        const file = path.startsWith(prefix) ? path.slice(prefix.length) : null;
        // Only files the package ships: no path is joined from the request.
        if (!file || !known.has(file)) return next();
        res.setHeader(
          "Content-Type",
          FONT_TYPES[file.split(".").pop() ?? ""] ?? "application/octet-stream",
        );
        createReadStream(join(dist, file)).pipe(res);
      });
    },
    generateBundle() {
      if (sawExcalidraw && rewritten !== 1) {
        this.error(
          `expected Excalidraw's esm.sh font fallback in one module, rewrote ${rewritten}`,
        );
      }
      for (const file of excalidrawFontFiles(dist)) {
        this.emitFile({
          type: "asset",
          fileName: `${EXCALIDRAW_ASSET_DIR}/${file}`,
          source: readFileSync(join(dist, file)),
        });
      }
    },
  };
}
