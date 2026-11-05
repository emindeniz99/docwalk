import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { firstLoadFiles, firstLoadFilesContaining } from "./first-load.ts";

/** A dist/ shaped like Vite's output: index.html, an entry chunk with lazy imports and their preload list. */
function fakeDist(entry: string): string {
  const dist = mkdtempSync(join(tmpdir(), "docwalk-first-load-"));
  mkdirSync(join(dist, "assets"));
  writeFileSync(
    join(dist, "index.html"),
    `<script type="module" crossorigin src="/assets/index-AAAAAAAA.js"></script>
<link rel="modulepreload" crossorigin href="/assets/runtime-BBBBBBBB.js">
<link rel="stylesheet" crossorigin href="/assets/index-CCCCCCCC.css">`,
  );
  writeFileSync(join(dist, "assets/index-AAAAAAAA.js"), entry);
  return dist;
}

const ENTRY =
  'const __vite__mapDeps=(i,m=__vite__mapDeps,d=(m.f||(m.f=["assets/App-DDDDDDDD.js","assets/deck-EEEEEEEE.js","assets/App-FFFFFFFF.css","assets/PresenterView-GGGGGGGG.js"])))=>i.map(i=>d[i]);' +
  "const A=lazy(()=>b(()=>import(`./App-DDDDDDDD.js`).then(e=>({default:e.App})),__vite__mapDeps([0,1,2])))," +
  "P=lazy(()=>b(()=>import(`./PresenterView-GGGGGGGG.js`),__vite__mapDeps([3,1])));";

describe("first-load file list (decision 43 budget)", () => {
  test("counts index.html's files and everything preloaded for App, which main.tsx loads at once", () => {
    // App is lazy so the remote and presenter skip it; index.html alone would
    // then undercount the main view by the whole app.
    expect(firstLoadFiles(fakeDist(ENTRY)).toSorted()).toEqual(
      [
        "assets/index-AAAAAAAA.js",
        "assets/runtime-BBBBBBBB.js",
        "assets/index-CCCCCCCC.css",
        "assets/App-DDDDDDDD.js",
        "assets/deck-EEEEEEEE.js",
        "assets/App-FFFFFFFF.css",
      ].toSorted(),
    );
  });

  test("leaves out chunks only other views load", () => {
    expect(firstLoadFiles(fakeDist(ENTRY))).not.toContain("assets/PresenterView-GGGGGGGG.js");
  });

  test("finds a marker in any first-load file, so opt-in code merged into an eager chunk is caught", () => {
    // Monaco (decision 53) is about 830 kB gzip; a static import anywhere on
    // the main path would fold it into App under App's own name, and every
    // visitor would download it. Only the contents give that away.
    const dist = fakeDist(ENTRY);
    for (const file of ["runtime-BBBBBBBB.js", "index-CCCCCCCC.css", "deck-EEEEEEEE.js"])
      writeFileSync(join(dist, "assets", file), "/* eager */");
    writeFileSync(join(dist, "assets/App-FFFFFFFF.css"), "/* eager */");
    writeFileSync(join(dist, "assets/App-DDDDDDDD.js"), "globalThis.MonacoEnvironment={}");
    writeFileSync(join(dist, "assets/PresenterView-GGGGGGGG.js"), "/* lazy */");
    expect(firstLoadFilesContaining(dist, "MonacoEnvironment")).toEqual(["assets/App-DDDDDDDD.js"]);
    writeFileSync(join(dist, "assets/App-DDDDDDDD.js"), "/* eager */");
    expect(firstLoadFilesContaining(dist, "MonacoEnvironment")).toEqual([]);
  });

  test("throws when the build no longer has the expected shape, instead of measuring less", () => {
    expect(() => firstLoadFiles(fakeDist("console.log(1)"))).toThrow(/no import\(\) of the App/);
  });
});
