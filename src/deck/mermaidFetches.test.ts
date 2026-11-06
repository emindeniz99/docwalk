import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { describe, expect, test } from "vitest";

/**
 * `remoteImages` in `mermaid.ts` refuses a diagram that names a remote image,
 * because Mermaid fetches it while rendering, before DOMPurify ever sees the
 * SVG. It knows the two places Mermaid 12.2 does that. This test lists every
 * image fetch in the Mermaid build we ship, by source module, so an upgrade
 * that adds one fails here instead of quietly leaking viewers' addresses.
 */
const mermaidDist = join(
  dirname(createRequire(import.meta.url).resolve("mermaid/package.json")),
  "dist",
);

const FETCHES = [
  /new Image\(/g,
  /\.(?:append|insert)\("(?:svg:)?image"/g,
  /createElementNS\([^)]*"image"/g,
  /\bdrawImage\(/g,
];

function fetchSites(): Record<string, number> {
  const files = [
    join(mermaidDist, "mermaid.core.mjs"),
    ...readdirSync(join(mermaidDist, "chunks/mermaid.core"))
      .filter((f) => f.endsWith(".mjs"))
      .map((f) => join(mermaidDist, "chunks/mermaid.core", f)),
  ];
  const sites: Record<string, number> = {};
  for (const file of files) {
    // esbuild marks where each source module starts: `// src/...`.
    const parts = readFileSync(file, "utf8").split(/^\/\/ (src\/\S+)$/m);
    for (let i = 1; i < parts.length; i += 2) {
      for (const pattern of FETCHES) {
        const count = parts[i + 1]?.match(pattern)?.length ?? 0;
        if (count) {
          const key = `${parts[i]} ${pattern.source}`;
          sites[key] = (sites[key] ?? 0) + count;
        }
      }
    }
  }
  return sites;
}

describe("Mermaid's image fetches are the ones remoteImages guards", () => {
  test("only image shapes and sequence actor icons load images", () => {
    expect(fetchSites()).toEqual({
      // A node's `img`: preloaded with new Image(), then drawn as <image>.
      "src/rendering-util/rendering-elements/shapes/imageSquare.ts new Image\\(": 1,
      'src/rendering-util/rendering-elements/shapes/imageSquare.ts \\.(?:append|insert)\\("(?:svg:)?image"': 1,
      // The shared helper, and its only callers: a sequence actor's `icon`.
      'src/diagrams/common/svgDrawCommon.ts \\.(?:append|insert)\\("(?:svg:)?image"': 1,
      "src/diagrams/sequence/svgDraw.js \\bdrawImage\\(": 3,
    });
  });
});
