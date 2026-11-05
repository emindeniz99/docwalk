import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import viteConfig from "../vite.config.ts";
import {
  excalidrawDistDir,
  excalidrawFontFiles,
  rewriteFontFallback,
} from "./excalidraw-assets-plugin.ts";

/**
 * Canvas mode must not send a visitor's IP address to a font CDN (decisions
 * 51, 54). Excalidraw would: it loads its fonts from esm.sh unless told
 * otherwise, and keeps esm.sh as a fallback even when told.
 */
describe("Excalidraw fonts come from this origin", () => {
  test("every font the package ships is copied, Excalifont (its default) among them", () => {
    // A font missing from the copy would make Excalidraw fall back to the CDN for it.
    const files = excalidrawFontFiles();
    expect(files.length).toBeGreaterThan(10);
    expect(files.some((f) => /^fonts\/Excalifont\/.+\.woff2$/.test(f))).toBe(true);
    expect(files.every((f) => f.startsWith("fonts/") && !f.includes("\\"))).toBe(true);
  });

  test("the esm.sh fallback in the installed Excalidraw is rewritten to this origin", () => {
    // Run against the real package: an Excalidraw upgrade that moves the fallback fails here.
    const dist = excalidrawDistDir();
    const chunk = readFileSync(join(dist, excalidrawChunkWithFallback(dist)), "utf8");
    const out = rewriteFontFallback(chunk, "/excalidraw-assets/");
    expect(out).not.toContain("esm.sh");
    expect(out).toContain('(location.origin + "/excalidraw-assets/")');
  });

  test("code without exactly one fallback fails the build instead of shipping a CDN fetch", () => {
    expect(() => rewriteFontFallback("const x = 1;", "/a/")).toThrow(/found 0/);
    const one = '`https://esm.sh/${p?`${p}@${v}`:"pkg"}/dist/prod/`';
    expect(() => rewriteFontFallback(`${one};${one}`, "/a/")).toThrow(/found 2/);
  });

  test("the plugin is part of the build", () => {
    const names = (viteConfig.plugins ?? []).flat().map((p) => (p as { name?: string }).name);
    expect(names).toContain("docwalk-excalidraw-assets");
  });
});

/** The prod chunk that holds `ASSETS_FALLBACK_URL` (its hashed name changes between versions). */
function excalidrawChunkWithFallback(dist: string): string {
  const name = readdirSync(dist).find(
    (f) => f.endsWith(".js") && readFileSync(join(dist, f), "utf8").includes("https://esm.sh/"),
  );
  if (!name) throw new Error("no Excalidraw chunk mentions esm.sh");
  return name;
}
