import { describe, expect, test } from "vitest";
import { parseMarkdown } from "../sectioning/sectionize";
import { BLOCKED_IMAGE_CLASS, nodesToHtml } from "./toHtml";

const render = (markdown: string, options = {}) =>
  nodesToHtml(parseMarkdown(markdown).children, options);

/** The `src` the browser would fetch, or null when the image waits for the viewer. */
function liveSrc(html: string): string | null {
  return /<img[^>]*?\ssrc="([^"]*)"/.exec(html)?.[1] ?? null;
}

/** The host the browser would contact while rendering, if it is not the page's own. */
function foreignHost(html: string): string | null {
  const src = liveSrc(html);
  if (src === null) return null;
  const host = new URL(src, "https://docwalk.invalid/").host;
  return host === "docwalk.invalid" ? null : host;
}

describe("remote image gate (decision 33)", () => {
  // Each of these makes the browser contact another host as soon as the page
  // renders, which leaks the viewer's IP address to whoever wrote the doc.
  // The browser's URL parser treats `//`, `/\` and `\\` alike as "another host".
  const remote = {
    "https URL": "https://tracker.example/p.png",
    "upper-case scheme": "HTTPS://tracker.example/p.png",
    "plain http": "http://tracker.example/p.png",
    "protocol-relative": "//tracker.example/p.png",
    "slash-backslash": "/\\tracker.example/p.png",
    "backslash-backslash": "\\\\tracker.example/p.png",
  };

  for (const [name, src] of Object.entries(remote)) {
    test(`a ${name} image never reaches another host before the viewer allows it`, () => {
      expect(foreignHost(render(`![pixel](<${src}>)`))).toBeNull();
    });
  }

  for (const src of ["https://tracker.example/p.png", "//tracker.example/p.png"]) {
    test(`${src} becomes a placeholder that remembers where it would load from`, () => {
      const html = render(`![pixel](${src})`);
      expect(liveSrc(html)).toBeNull();
      expect(html).toContain(BLOCKED_IMAGE_CLASS);
      // Resolved to an absolute URL, so the click handler can re-check the scheme.
      expect(html).toContain('data-src="https://tracker.example/p.png"');
    });
  }

  test("a blocked image is a keyboard-reachable button that says what it would load", () => {
    const html = render("![Architecture](https://images.example/arch.png)");
    expect(html).toContain('tabindex="0"');
    expect(html).toContain('role="button"');
    expect(html).toMatch(/aria-label="[^"]*Architecture[^"]*images\.example[^"]*"/);
  });

  test("relative images stay on the page's own origin, so they load at once", () => {
    expect(liveSrc(render("![a](img/a.png)"))).toBe("img/a.png");
    expect(liveSrc(render("![a](/img/a.png)"))).toBe("/img/a.png");
  });

  test("the always-load setting lets remote images through unchanged", () => {
    const html = render("![a](//images.example/a.png)", { loadRemoteImages: true });
    expect(liveSrc(html)).toBe("//images.example/a.png");
    expect(html).not.toContain(BLOCKED_IMAGE_CLASS);
  });
});
