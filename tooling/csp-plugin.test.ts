import { describe, expect, test } from "vitest";
import { CONTENT_SECURITY_POLICY } from "../worker/csp.ts";
import viteConfig from "../vite.config.ts";
import { docwalkCspMeta, metaContentSecurityPolicy, withCspMeta } from "./csp-plugin.ts";

const INDEX = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>docwalk</title>
    <script type="module" crossorigin src="/assets/index.js"></script>
  </head>
</html>`;

/** What the plugin's transformIndexHtml hook makes of index.html in a build. */
function transformed(html = INDEX): string {
  const hook = docwalkCspMeta().transformIndexHtml as { handler: (html: string) => string };
  return hook.handler(html);
}

/** The CSP read back out of the tag, as an HTML parser would decode it. */
function cspContent(html: string): string | null {
  const match = /<meta http-equiv="Content-Security-Policy" content="([^"]*)"/.exec(html);
  return match?.[1]?.replaceAll("&#39;", "'") ?? null;
}

describe("static-mode CSP <meta> (decision 34)", () => {
  // GitHub Pages and most static hosts ignore _headers, so without this tag a
  // sanitizer slip on a static deploy runs with no CSP behind it at all.
  test("the build puts the Worker's policy into index.html, ahead of every script", () => {
    const html = transformed();
    expect(cspContent(html)).toBe(metaContentSecurityPolicy(CONTENT_SECURITY_POLICY));
    // A meta CSP governs only what the parser meets after it; the charset stays first.
    expect(html.indexOf("Content-Security-Policy")).toBeLessThan(html.indexOf("<script"));
    expect(html.indexOf("<meta charset")).toBeLessThan(html.indexOf("Content-Security-Policy"));
  });

  test("an index.html without <meta charset> fails the build instead of shipping no CSP", () => {
    expect(() => withCspMeta("<html><head></head></html>")).toThrow(/charset/);
  });

  test("it keeps every directive of the header except frame-ancestors, which a meta tag cannot carry", () => {
    const meta = metaContentSecurityPolicy();
    expect(meta).not.toContain("frame-ancestors");
    const header = CONTENT_SECURITY_POLICY.split("; ").filter(
      (d) => !d.startsWith("frame-ancestors"),
    );
    expect(meta.split("; ")).toEqual(header);
    expect(meta).toContain("script-src 'self'");
  });

  test("the production build actually uses the plugin", () => {
    const names = (viteConfig.plugins ?? []).flat().map((p) => (p && "name" in p ? p.name : null));
    expect(names).toContain(docwalkCspMeta().name);
  });

  test("it applies to builds only, because dev needs an inline React Refresh script", () => {
    expect(docwalkCspMeta().apply).toBe("build");
  });
});
