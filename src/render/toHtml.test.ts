import { describe, expect, test } from "vitest";
import { headingIds, parseMarkdown } from "../sectioning/sectionize";
import { BLOCKED_IMAGE_CLASS, nodesToHtml } from "./toHtml";

const render = (markdown: string, options = {}) =>
  nodesToHtml(parseMarkdown(markdown).children, options);

/** The `src` the browser would fetch, or null when the image waits for the viewer. */
function liveSrc(html: string): string | null {
  return /<img[^>]*?\ssrc="([^"]*)"/.exec(html)?.[1] ?? null;
}

/**
 * The host the browser would contact while rendering, if it is not the
 * page's own. Checked against an https and an http page: `https:host/x`
 * stays on an https page but leaves an http one (`wrangler dev`,
 * `vite preview`, a LAN self-host), so one page scheme alone hides it.
 */
function foreignHost(html: string): string | null {
  const src = liveSrc(html);
  if (src === null) return null;
  for (const page of ["https://docwalk.invalid/", "http://docwalk.invalid/"]) {
    const host = new URL(src, page).host;
    if (host !== "docwalk.invalid") return host;
  }
  return null;
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
    // A special scheme with no slashes is relative only when it matches the
    // page's scheme, so these leave whichever page scheme they do not match.
    "https: without slashes": "https:tracker.example/p.png",
    "http: without slashes": "http:tracker.example/p.png",
    "https: with one slash": "https:/tracker.example/p.png",
  };

  for (const [name, src] of Object.entries(remote)) {
    test(`a ${name} image never reaches another host before the viewer allows it`, () => {
      expect(foreignHost(render(`![pixel](<${src}>)`))).toBeNull();
    });
  }

  for (const src of [
    "https://tracker.example/p.png",
    "//tracker.example/p.png",
    "https:tracker.example/p.png",
  ]) {
    test(`${src} becomes a placeholder that remembers where it would load from`, () => {
      const html = render(`![pixel](${src})`);
      expect(liveSrc(html)).toBeNull();
      expect(html).toContain(BLOCKED_IMAGE_CLASS);
      // Resolved to an absolute URL, so the click handler can re-check the scheme.
      expect(html).toContain('data-docwalk-src="https://tracker.example/p.png"');
      // Never `data-src`: reveal.js copies that into `src` on nearby slides.
      expect(html).not.toContain("data-src=");
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

describe("raw HTML: what GitHub renders, and nothing else", () => {
  // rehype-raw runs before rehype-sanitize, so raw HTML reaches the
  // sanitizer as elements; before, every raw tag was dropped, and READMEs
  // lost their <details> sections and keyboard shortcuts.
  test("details/summary, kbd, sup, br and an image's width render as on GitHub", () => {
    const html = render(
      '<details><summary>More</summary>\n\nHidden *md*\n\n</details>\n\nPress <kbd>Ctrl</kbd>, x<sup>2</sup><br>next\n\n<img src="a.png" width="120">',
    );
    expect(html).toContain("<details><summary>More</summary>");
    expect(html).toContain("<em>md</em>");
    expect(html).toContain("<kbd>Ctrl</kbd>");
    expect(html).toContain("x<sup>2</sup><br>next");
    expect(html).toContain('<img src="a.png" width="120">');
  });

  test("scripts, frames, styles and handlers in raw HTML are removed", () => {
    const html = render(
      '<script>x()</script><iframe src="https://e.example"></iframe><style>*{}</style>\n\n<p style="color:red" onclick="x()">t</p>',
    );
    expect(html).not.toMatch(/<script|<iframe|<style|style=|onclick/i);
    expect(html).toContain("<p>t</p>");
  });

  test("raw HTML that crashes the HTML parser drops the raw HTML instead of the whole deck", () => {
    // hast-util-from-parse5 throws on a <template> inside SVG or MathML
    // (found by the sanitize-twice property); one hostile line must not
    // stop every slide from rendering.
    for (const md of ["<svg><template>", "<math><template>x</template></math>"]) {
      const html = render(`Before.\n\n${md}\n\nAfter *this*.`);
      expect(html).toContain("<p>Before.</p>");
      expect(html).toContain("<em>this</em>");
      expect(html).not.toMatch(/<svg|<math|<template/);
    }
  });

  test("a <style> element goes with its CSS, which would otherwise show on the slide as text", () => {
    // The GitHub schema unwraps disallowed elements and keeps their text. In
    // a table, a <style>'s text then sat inside <table>, which the browser
    // re-parses by moving it out: the output was not a fixed point (found by
    // the sanitize-twice property).
    expect(render("<style>.x { color: red }</style>\n\nText").trim()).toBe("<p>Text</p>");
    expect(render("<table><style>!")).toBe("<table></table>");
  });

  test("raw HTML cannot borrow alert classes to pass as docwalk's own markup", () => {
    const html = render('<div class="markdown-alert markdown-alert-caution">forged</div>');
    expect(html).toBe("<div>forged</div>");
  });

  test("a <picture> source on another host is dropped, so the remote image gate still holds", () => {
    // GitHub's schema keeps <source srcset>; the browser would fetch it at render time.
    const leaks = [
      "https://t.example/a.png 2x",
      "local.png 1x, //t.example/b.png 2x",
      "local.png,//t.example/c.png",
      "https:t.example/d.png",
      "local.png 1x, http:t.example/e.png 2x",
    ].filter((srcset) =>
      render(`<picture><source srcset="${srcset}"><img src="b.png"></picture>`).includes(
        "t.example",
      ),
    );
    expect(leaks).toEqual([]);
  });

  test("a same-origin <picture> source stays", () => {
    expect(render('<picture><source srcset="dark.png 2x"><img src="b.png"></picture>')).toContain(
      'srcset="dark.png 2x"',
    );
  });
});

describe("GitHub alerts (decision 25)", () => {
  for (const kind of ["note", "tip", "important", "warning", "caution"]) {
    const title = `${kind.charAt(0).toUpperCase()}${kind.slice(1)}`;
    test(`> [!${kind.toUpperCase()}] renders as GitHub's ${kind} alert, titled "${title}"`, () => {
      const html = render(`> [!${kind.toUpperCase()}]\n> Body text.`);
      expect(html).toContain(`class="markdown-alert markdown-alert-${kind}"`);
      expect(html).toMatch(
        new RegExp(
          `<p class="markdown-alert-title"><svg[^>]*aria-hidden="true"[\\s\\S]*?</svg>${title}</p>`,
        ),
      );
      expect(html).toContain("<p>Body text.</p>");
      expect(html).not.toContain("[!");
    });
  }

  test("an unknown marker or a marker with text after it stays a plain quote, as on GitHub", () => {
    expect(render("> [!FOO]\n> x")).toContain("<blockquote>");
    expect(render("> [!NOTE] same line")).toContain("<blockquote>");
  });

  test("an alert's content is sanitized like any other", () => {
    const html = render('> [!NOTE]\n> <img src="a.png" onerror="x()"><script>x()</script>');
    expect(html).toContain("markdown-alert-note");
    expect(html).not.toMatch(/onerror|<script/);
  });
});

describe("footnotes", () => {
  test("in document mode a reference links to its definition, and back, with matching ids", () => {
    // The sanitizer prefixes ids; remark-rehype's own prefix used to double
    // that to user-content-user-content-fn-a, so no footnote link ever matched.
    // Links keep GitHub's unprefixed form and are resolved like heading links.
    const html = render("Text.[^a]\n\n[^a]: Alpha.");
    expect(html).toContain('<a href="#fn-a" id="user-content-fnref-a"');
    expect(html).toContain('<li id="user-content-fn-a">');
    expect(html).toContain('href="#fnref-a"');
  });

  test("a slide that references a footnote defined elsewhere shows the definition", () => {
    const root = parseMarkdown("## One\n\nRef.[^a]\n\n## Two\n\nx\n\n[^a]: The definition.");
    const definitions = root.children.filter((n) => n.type === "footnoteDefinition");
    const slide = nodesToHtml(root.children.slice(0, 2), { definitions, footnotePrefix: "one-" });
    expect(slide).toContain("The definition.");
    expect(slide).toContain('href="#one-fn-a"');
    expect(slide).toContain('id="user-content-one-fn-a"');
  });

  test("a slide that references no footnote gets no footnote list", () => {
    const root = parseMarkdown("## Two\n\nx\n\n[^a]: The definition.");
    const definitions = root.children.filter((n) => n.type === "footnoteDefinition");
    expect(nodesToHtml(root.children.slice(0, 2), { definitions })).not.toContain("footnotes");
  });

  test("two slides' footnote lists never share an id, including the hidden label", () => {
    const root = parseMarkdown("A.[^a]\n\n[^a]: Alpha.");
    const ids = (prefix: string) =>
      [...nodesToHtml(root.children, { footnotePrefix: prefix }).matchAll(/id="([^"]+)"/g)].map(
        (m) => m[1],
      );
    const first = ids("one-");
    expect(first).toContain("user-content-one-footnote-label");
    expect(first.filter((id) => ids("two-").includes(id))).toEqual([]);
  });

  test("a link reference whose definition sits on another slide still renders as a link", () => {
    const root = parseMarkdown("See [the spec][spec].\n\n[spec]: https://example.com/spec");
    const [para, def] = root.children;
    expect(nodesToHtml([para!], { definitions: [def!] })).toContain(
      '<a href="https://example.com/spec">the spec</a>',
    );
  });
});

describe("heading ids", () => {
  test("headings get GitHub's user-content- anchor ids, so fragment links can find them", () => {
    const root = parseMarkdown("## Plan\n\n#### Retry budget\n");
    const ids = new Map(
      root.children.flatMap((n) =>
        n.type === "heading" ? [[n, n.depth === 2 ? "plan" : "retry-budget"] as const] : [],
      ),
    );
    const html = nodesToHtml(root.children, { headingIds: ids });
    expect(html).toContain('<h2 id="user-content-plan">Plan</h2>');
    expect(html).toContain('<h4 id="user-content-retry-budget">Retry budget</h4>');
    // The parsed tree is shared with the sectioner and the editor; rendering never changes it.
    expect(root.children[0]?.data).toBeUndefined();
  });

  test("a heading inside a quote or a list item gets its anchor id too (decision 107)", () => {
    const root = parseMarkdown("> ### Quoted part\n\n- #### In a list\n");
    const html = nodesToHtml(root.children, { headingIds: headingIds(root) });
    expect(html).toContain('<h3 id="user-content-quoted-part">Quoted part</h3>');
    expect(html).toContain('<h4 id="user-content-in-a-list">In a list</h4>');
  });
});
