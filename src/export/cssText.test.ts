import { describe, expect, test } from "vitest";
import { escapeStyleText, parseUnicodeRange, rangeCoversText, rewriteCssUrls } from "./cssText";

const BASE = "https://docwalk.test/assets/app.css";
const sameOrigin = (url: URL) => url.origin === "https://docwalk.test";
const nothing = () => false;

describe("rewriteCssUrls", () => {
  test("a foreign url() becomes none, so copied CSS cannot fetch from a third party", () => {
    const css = `.a { background: url("https://tracker.example/p.gif") }`;
    expect(rewriteCssUrls(css, BASE, sameOrigin)).toBe(".a { background: none }");
  });

  test("a relative url() resolves against its own stylesheet, not the page", () => {
    // Fontsource files sit next to their CSS; resolving against the page would 404.
    const css = `@font-face { src: url(./files/inter.woff2) format("woff2") }`;
    expect(rewriteCssUrls(css, BASE, sameOrigin)).toBe(
      `@font-face { src: url("https://docwalk.test/assets/files/inter.woff2") format("woff2") }`,
    );
  });

  test("the offline policy drops even same-origin URLs, because the HTML file is opened elsewhere", () => {
    expect(rewriteCssUrls(`.a { cursor: url('/hand.png'), auto }`, BASE, nothing)).toBe(
      ".a { cursor: none, auto }",
    );
  });

  test("data: URLs and local fragments stay: they never fetch, and SVG markers need url(#id)", () => {
    const css = `.a { marker-end: url(#arrow); background: url("data:image/png;base64,AAAA") }`;
    expect(rewriteCssUrls(css, BASE, nothing)).toBe(css);
  });

  test("an empty url() is refused, since it would resolve to the stylesheet itself", () => {
    expect(rewriteCssUrls(`.a { background: url("") }`, BASE, sameOrigin)).toBe(
      ".a { background: none }",
    );
  });
});

describe("escapeStyleText", () => {
  test("CSS text can never close its <style> element and start markup", () => {
    const out = escapeStyleText(`.a::after { content: "</style><img src=x onerror=alert(1)>" }`);
    expect(out).not.toContain("<");
  });
});

describe("unicode-range", () => {
  test("parses single points, ranges and wildcards", () => {
    expect(parseUnicodeRange("U+0-FF, U+131, U+4??")).toEqual([
      [0, 0xff],
      [0x131, 0x131],
      [0x400, 0x4ff],
    ]);
  });

  test("a face is embedded only when the slides use one of its characters, which keeps the file small", () => {
    const latin = parseUnicodeRange("U+0000-00FF");
    const cyrillic = parseUnicodeRange("U+0400-045F");
    expect(rangeCoversText(latin, "Ledger")).toBe(true);
    expect(rangeCoversText(cyrillic, "Ledger")).toBe(false);
    expect(rangeCoversText(cyrillic, "Ledger Привет")).toBe(true);
  });

  test("a face without unicode-range covers everything", () => {
    expect(rangeCoversText(parseUnicodeRange(""), "anything")).toBe(true);
  });
});
