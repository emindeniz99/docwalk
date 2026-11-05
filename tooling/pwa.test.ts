import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { tokens } from "../src/design/tokens.ts";
import { CONTENT_SECURITY_POLICY } from "../worker/csp.ts";
import viteConfig from "../vite.config.ts";
import { ICON_FILES, iconSvg, selectPrecache, webManifest, type ChunkNode } from "./pwa.ts";

const publicDir = join(import.meta.dirname, "..", "public");

/** Width and height from a PNG's IHDR chunk. */
function pngSize(file: string): { width: number; height: number } | null {
  const bytes = readFileSync(join(publicDir, file));
  if (bytes.subarray(1, 4).toString("latin1") !== "PNG") return null;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

describe("app icons", () => {
  // The icons are rendered from the token module; a palette change that
  // skipped `pnpm icons` would ship a home-screen icon in the old colours.
  test("the committed SVGs are what iconSvg() draws from the current tokens", () => {
    for (const icon of ICON_FILES.filter((i) => i.size === null)) {
      const committed = readFileSync(join(publicDir, icon.file), "utf8");
      expect({ [icon.file]: committed }).toEqual({
        [icon.file]: iconSvg({ maskable: icon.maskable }),
      });
    }
  });

  test("every PNG exists at the size it claims", () => {
    for (const icon of ICON_FILES.filter((i) => i.size !== null)) {
      expect({ [icon.file]: pngSize(icon.file) }).toEqual({
        [icon.file]: { width: icon.size, height: icon.size },
      });
    }
  });

  // Android launchers crop a maskable icon to any shape inside the central
  // circle of radius 0.4 x size; anything outside it can be cut off.
  test("the maskable drawing stays inside the safe circle and its ground fills the square", () => {
    const svg = iconSvg({ maskable: true });
    expect(svg).toMatch(/^<svg[^>]*><rect width="512" height="512" fill="[^"]+"\/>/);
    const scale = Number(/scale\(([\d.]+)\)/.exec(svg)?.[1]);
    const rects = [...svg.matchAll(/<rect x="(\d+)" y="(\d+)" width="(\d+)" height="(\d+)"/g)];
    expect(rects.length).toBeGreaterThan(0);
    for (const [, x, y, w, h] of rects) {
      for (const [px, py] of [
        [Number(x), Number(y)],
        [Number(x) + Number(w), Number(y) + Number(h)],
        [Number(x), Number(y) + Number(h)],
        [Number(x) + Number(w), Number(y)],
      ] as const) {
        const distance = Math.hypot((px - 256) * scale, (py - 256) * scale);
        expect(distance).toBeLessThanOrEqual(0.4 * 512);
      }
    }
  });
});

describe("web app manifest (decision 11)", () => {
  const manifest = webManifest();

  // Chromium offers "Install" only with a name, a start URL, a standalone
  // display and both a 192 px and a 512 px icon.
  test("meets the browser's installability criteria", () => {
    expect(manifest.name).toBe("docwalk");
    expect(manifest.short_name.length).toBeLessThanOrEqual(12);
    expect(manifest.start_url).toBeTruthy();
    expect(["standalone", "fullscreen", "minimal-ui"]).toContain(manifest.display);
    const any = manifest.icons.filter((i) => i.purpose === "any" && i.type === "image/png");
    expect(any.map((i) => i.sizes)).toEqual(expect.arrayContaining(["192x192", "512x512"]));
    expect(manifest.icons.some((i) => i.purpose === "maskable" && i.sizes === "512x512")).toBe(
      true,
    );
  });

  test("every icon it names is a file the build ships, with a matching size", () => {
    const missing = manifest.icons.filter((icon) => !existsSync(join(publicDir, icon.src)));
    expect(missing).toEqual([]);
    const claimed = manifest.icons
      .filter((icon) => icon.type === "image/png")
      .map((icon) => ({ src: icon.src, sizes: icon.sizes }));
    const actual = claimed.map(({ src }) => {
      const size = pngSize(src);
      return { src, sizes: `${size?.width}x${size?.height}` };
    });
    expect(actual).toEqual(claimed);
  });

  // A GitHub Pages project site lives under /<repo>/; absolute paths would
  // point the installed app at the user's root site instead.
  test("paths are relative, so the app installs from a subpath too", () => {
    for (const path of [
      manifest.start_url,
      manifest.scope,
      manifest.id,
      ...manifest.icons.map((i) => i.src),
    ])
      expect(path.startsWith("/")).toBe(false);
  });

  test("its colours are design tokens (decision 52)", () => {
    expect(Object.values(tokens.colors)).toContain(manifest.theme_color);
    expect(Object.values(tokens.colors)).toContain(manifest.background_color);
  });
});

const directive = (name: string) =>
  CONTENT_SECURITY_POLICY.split(";")
    .map((d) => d.trim().split(/\s+/))
    .find(([n]) => n === name)
    ?.slice(1);

describe("the service worker under the CSP (decision 34)", () => {
  // Registration of /sw.js is checked against worker-src; the manifest
  // against manifest-src, which falls back to default-src.
  test("allows a same-origin worker script and manifest", () => {
    expect(directive("worker-src")).toContain("'self'");
    expect(directive("manifest-src") ?? directive("default-src")).toContain("'self'");
  });

  test("the build includes the PWA plugin", () => {
    const names = (viteConfig.plugins ?? []).flat().map((p) => (p && "name" in p ? p.name : null));
    expect(names).toContain("docwalk-pwa");
  });
});

// ---- Precache selection ----------------------------------------------------

const chunk = (fileName: string, rest: Partial<ChunkNode> = {}): ChunkNode => ({
  fileName,
  isEntry: false,
  imports: [],
  dynamicImports: [],
  moduleIds: [`/app/src/${fileName}.ts`],
  css: [],
  ...rest,
});

const MERMAID = "/app/node_modules/.pnpm/mermaid@12.2.0/node_modules/mermaid/dist/mermaid.core.mjs";

describe("selectPrecache", () => {
  // The offline promise: whatever docwalk's own code can load (editor,
  // parser, Mermaid's core, export, presenter) must be on disk after install.
  test("precaches the entry, its imports, and every chunk docwalk's own code imports lazily", () => {
    const { precache, runtime } = selectPrecache([
      chunk("index.js", { isEntry: true, imports: ["shared.js"], dynamicImports: ["App.js"] }),
      chunk("shared.js"),
      chunk("App.js", { css: ["App.css"], dynamicImports: ["mermaid.core.js", "Export.js"] }),
      chunk("Export.js"),
      chunk("mermaid.core.js", { moduleIds: [MERMAID], imports: ["d3.js"] }),
      chunk("d3.js", { moduleIds: ["/app/node_modules/d3/index.js"] }),
    ]);
    expect([...precache].toSorted()).toEqual(
      [
        "App.css",
        "App.js",
        "Export.js",
        "d3.js",
        "index.js",
        "mermaid.core.js",
        "shared.js",
      ].toSorted(),
    );
    expect([...runtime]).toEqual([]);
  });

  // Mermaid loads one chunk per diagram type, plus ELK (1.4 MB) and others;
  // precaching all of them would multiply every install for diagrams most
  // documents never use. They are cached the first time a deck needs them.
  test("leaves chunks a dependency loads by itself to the runtime cache", () => {
    const { precache, runtime } = selectPrecache([
      chunk("index.js", { isEntry: true, dynamicImports: ["mermaid.core.js"] }),
      chunk("mermaid.core.js", {
        moduleIds: [MERMAID],
        dynamicImports: ["flowDiagram.js", "elk.js"],
      }),
      chunk("flowDiagram.js", {
        moduleIds: ["/app/node_modules/mermaid/dist/flow.mjs"],
        css: ["flow.css"],
      }),
      chunk("elk.js", { moduleIds: ["/app/node_modules/elkjs/lib/elk.js"] }),
    ]);
    expect(precache.has("mermaid.core.js")).toBe(true);
    expect([...runtime].toSorted()).toEqual(["elk.js", "flow.css", "flowDiagram.js"]);
  });

  test("still precaches a dependency chunk that the app also imports statically", () => {
    const { precache } = selectPrecache([
      chunk("index.js", {
        isEntry: true,
        imports: ["util.js"],
        dynamicImports: ["mermaid.core.js"],
      }),
      chunk("mermaid.core.js", { moduleIds: [MERMAID], dynamicImports: ["util.js"] }),
      chunk("util.js", { moduleIds: ["/app/node_modules/lodash/x.js"] }),
    ]);
    expect(precache.has("util.js")).toBe(true);
  });

  // Monaco (decision 53) and canvas mode (decision 54) are opt-in and
  // several megabytes each; docwalk imports them, but most visitors never do.
  test("opt-in heavy packages are cached on first use even though docwalk imports them", () => {
    const { precache, runtime } = selectPrecache([
      chunk("index.js", { isEntry: true, dynamicImports: ["Monaco.js"] }),
      chunk("Monaco.js", {
        moduleIds: [
          "/app/src/editor/Monaco.tsx",
          "/app/node_modules/.pnpm/monaco-editor@0.55.1/node_modules/monaco-editor/esm/x.js",
        ],
      }),
    ]);
    expect(precache.has("Monaco.js")).toBe(false);
    expect(runtime.has("Monaco.js")).toBe(true);
  });

  test("fails loudly when the graph names a chunk the build did not emit", () => {
    expect(() =>
      selectPrecache([chunk("index.js", { isEntry: true, imports: ["gone.js"] })]),
    ).toThrow(/gone\.js/);
  });
});
