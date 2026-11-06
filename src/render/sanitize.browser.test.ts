import { fc, test as fcTest } from "@fast-check/vitest";
import type { Html } from "mdast";
import { afterEach, describe, expect, test } from "vitest";
import { purifyHtml } from "../deck/purify";
import { parseMarkdown } from "../sectioning/sectionize";
import { nodesToHtml } from "./toHtml";

/**
 * Sanitizer corpus (decision 42). Raw HTML now reaches the sanitizer as real
 * elements (rehype-raw), so the two-pass sanitizer (rehype-sanitize, then
 * DOMPurify in the browser) is all that stands between a hostile document
 * and the viewer's session. Every payload sets `window.dwXssRan` instead of
 * calling alert: the test inserts the output into the live page and fails
 * when anything actually runs, not only when a string looks dangerous.
 */

declare global {
  interface Window {
    dwXssRan?: unknown;
  }
}

const RUN = "dwXssRan=1";

/**
 * DOMPurify's public test corpus, Cure53's mXSS write-ups and GitHub-specific
 * shapes (Markdown links, autolinks, footnotes). Each is a whole document.
 */
const CORPUS: Record<string, string> = {
  "script tag": `<script>${RUN}</script>`,
  "split script tag": `<scr<script>ipt>${RUN}</script>`,
  "img onerror": `<img src="x" onerror="${RUN}">`,
  "img onerror, slash separators": `<img/src/onerror=${RUN}>`,
  "img onerror after a backtick": `<img src="x\` \`<script>${RUN}</script>"\` \`>`,
  "svg onload": `<svg onload="${RUN}"></svg>`,
  "svg animate onbegin": `<svg><animate onbegin="${RUN}" attributeName="x" dur="1s"></animate></svg>`,
  "svg a xlink:href": `<svg><a xlink:href="javascript:${RUN}"><text y="20">x</text></a></svg>`,
  "svg use data URL": `<svg><use href="data:image/svg+xml,<svg id='x' xmlns='http://www.w3.org/2000/svg'><image href='x' onerror='${RUN}'/></svg>#x"></use></svg>`,
  "math href": `<math href="javascript:${RUN}">x</math>`,
  "details ontoggle": `<details open ontoggle="${RUN}"><summary>s</summary></details>`,
  "input autofocus": `<input autofocus onfocus="${RUN}">`,
  "body onload": `<body onload="${RUN}">`,
  "marquee onstart": `<marquee onstart="${RUN}">x</marquee>`,
  "video source onerror": `<video><source onerror="${RUN}"></video>`,
  "iframe srcdoc": `<iframe srcdoc="<script>parent.${RUN}</script>"></iframe>`,
  "iframe javascript src": `<iframe src="javascript:parent.${RUN}"></iframe>`,
  "object data": `<object data="javascript:${RUN}"></object>`,
  "embed src": `<embed src="javascript:${RUN}">`,
  "base href": `<base href="javascript:${RUN}//">`,
  "meta refresh": `<meta http-equiv="refresh" content="0;url=javascript:${RUN}">`,
  "link import": `<link rel="import" href="data:text/html,<script>${RUN}</script>">`,
  "form action": `<form action="javascript:${RUN}"><button>go</button></form>`,
  "button formaction": `<button formaction="javascript:${RUN}">go</button>`,
  "style attribute": `<p style="background:url(javascript:${RUN})">x</p>`,
  "style element import": `<style>@import "https://evil.invalid/x.css";</style>`,
  "a javascript href": `<a href="javascript:${RUN}">x</a>`,
  "a javascript href, entity encoded": `<a href="&#106;avascript:${RUN}">x</a>`,
  "a javascript href, tab inside": `<a href="jav&#x09;ascript:${RUN}">x</a>`,
  "a javascript href, leading space": `<a href=" javascript:${RUN}">x</a>`,
  "a javascript href, &colon;": `<a href="javascript&colon;${RUN}">x</a>`,
  "a vbscript href": `<a href="vbscript:${RUN}">x</a>`,
  "a data:text/html href": `<a href="data:text/html,<script>${RUN}</script>">x</a>`,
  "markdown javascript link": `[x](javascript:${RUN})`,
  "markdown javascript image": `![x](javascript:${RUN})`,
  "markdown javascript autolink": `<javascript:${RUN}>`,
  "markdown javascript reference": `[x][r]\n\n[r]: javascript:${RUN}`,
  "footnote with raw HTML": `x[^a]\n\n[^a]: <img src="x" onerror="${RUN}">`,
  "alert with raw HTML": `> [!WARNING]\n> <img src="x" onerror="${RUN}">`,
  // mXSS: markup that serializes into something else when the browser re-parses it.
  "mXSS svg/p/style": `<svg></p><style><a id="</style><img src=1 onerror=${RUN}>">`,
  "mXSS math/mtext/table/mglyph": `<math><mtext><table><mglyph><style><!--</style><img title="--&gt;&lt;img src=1 onerror=${RUN}&gt;">`,
  "mXSS nested forms": `<form><math><mtext></form><form><mglyph><style></math><img src onerror=${RUN}>`,
  "mXSS noscript title": `<noscript><p title="</noscript><img src=x onerror=${RUN}>">`,
  "mXSS svg style": `<svg><style><img src=x onerror=${RUN}></style></svg>`,
  "mXSS template style": `<template><style></template><img src=x onerror=${RUN}>`,
  "mXSS textarea": `<textarea></textarea><img src=x onerror=${RUN}>`,
  "mXSS xmp": `<xmp><img src=x onerror=${RUN}></xmp>`,
  "mXSS title": `<title><img src=x onerror=${RUN}></title>`,
  "mXSS select/option": `<select><option><img src=x onerror=${RUN}></option></select>`,
  "mXSS comment": `<!--><img src=x onerror=${RUN}>-->`,
  "mXSS CDATA in svg": `<svg><![CDATA[><img src=x onerror=${RUN}>]]></svg>`,
  "mXSS table foster parenting": `<table><img src=x onerror=${RUN}><tr><td>x</td></tr></table>`,
  // DOM clobbering: content names must never shadow document properties.
  "clobber document property": `<img name="getElementById"><a id="cookie" href="x">x</a>`,
  "clobber with form and input": `<form id="__proto__"><input name="attributes"></form>`,
};

/** Elements nothing in a document may produce. Alert icons are ours and checked separately. */
const FORBIDDEN =
  "script, iframe, frame, object, embed, style, link, meta, base, form, input, button, textarea, select, template, noscript, foreignObject, math, video, audio, body";
const URL_ATTRS = new Set([
  "href",
  "src",
  "xlink:href",
  "action",
  "formaction",
  "srcset",
  "data",
  "poster",
  "background",
  "cite",
  "longdesc",
]);

function render(markdown: string): HTMLElement {
  const host = document.createElement("div");
  host.append(purifyHtml(nodesToHtml(parseMarkdown(markdown).children)));
  document.body.append(host);
  return host;
}

/** Everything about the inserted DOM that would let a document run code or reach out. */
function hazards(host: HTMLElement): string[] {
  const found: string[] = [];
  for (const el of host.querySelectorAll(FORBIDDEN)) found.push(`<${el.localName}>`);
  for (const svg of host.querySelectorAll("svg")) {
    if (!svg.parentElement?.matches(".markdown-alert > .markdown-alert-title")) found.push("<svg>");
  }
  for (const el of host.querySelectorAll("*")) {
    for (const attr of el.attributes) {
      const name = attr.name.toLowerCase();
      if (name.startsWith("on")) found.push(`${el.localName}[${name}]`);
      if (name === "style" || name === "srcdoc") found.push(`${el.localName}[${name}]`);
      if (URL_ATTRS.has(name) && /^\s*(javascript|vbscript|data:text)/i.test(attr.value)) {
        found.push(`${el.localName}[${name}=${attr.value}]`);
      }
      if ((name === "id" || name === "name") && !attr.value.startsWith("user-content-")) {
        found.push(`${el.localName}[${name}=${attr.value}] clobbers`);
      }
    }
  }
  return found;
}

afterEach(() => {
  document.body.replaceChildren();
  delete window.dwXssRan;
});

describe("sanitizer corpus: nothing runs, nothing dangerous survives", () => {
  for (const [name, markdown] of Object.entries(CORPUS)) {
    test(`corpus: ${name}`, async () => {
      const host = render(markdown);
      expect(hazards(host)).toEqual([]);
      // Give error and load events (a broken src="x" fails fast) time to fire.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(window.dwXssRan).toBeUndefined();
      // A clobbered document would break the app, not only leak.
      expect(typeof document.getElementById).toBe("function");
    });
  }

  test("every link that survives resolves, in the browser's own reading, to a web or mail URL", () => {
    // `a.protocol` is the browser's parse, after entities, tabs and spaces:
    // the reading that decides whether a click runs script.
    const host = render(Object.values(CORPUS).join("\n\n"));
    const protocols = new Set(
      [...host.querySelectorAll<HTMLAnchorElement>("a[href]")].map((a) => a.protocol),
    );
    expect([...protocols].filter((p) => !["http:", "https:", "mailto:"].includes(p))).toEqual([]);
  });
});

// ---- Sanitize-twice: the output is a fixed point --------------------------

/**
 * Fragments that make HTML parsers disagree: namespace switches, raw-text
 * elements, comments, CDATA, table foster parenting, unclosed attributes.
 */
const TOKENS = [
  "<svg>",
  "</svg>",
  "<math>",
  "</math>",
  "<mtext>",
  "<mglyph>",
  "<style>",
  "</style>",
  "<noscript>",
  "</noscript>",
  "<template>",
  "</template>",
  "<textarea>",
  "</textarea>",
  "<title>",
  "<xmp>",
  "<iframe>",
  "<select>",
  "<option>",
  "<table>",
  "<tr>",
  "<td>",
  "</table>",
  "<form>",
  "</form>",
  "<p>",
  "</p>",
  '<a href="',
  "</a>",
  "<details open>",
  "<summary>",
  "</details>",
  "<kbd>",
  "<sup>",
  // Elements the schema unwraps while the parser treats them as scopes or
  // special nodes: a `<p>`, `<li>`, `<dd>` or heading stays open across them,
  // and unwrapping leaves a child the parser would have closed it for.
  "<marquee>",
  "<applet>",
  "<object>",
  "<button>",
  "<center>",
  "<u>",
  "<dl>",
  "<dd>",
  "<dt>",
  "<li>",
  "<hr>",
  "<h1>",
  "<h2>",
  "<br>",
  '<img src="x" width="9" ',
  `onerror="${RUN}"`,
  '<div title="',
  '">',
  "<!--",
  "-->",
  "<![CDATA[",
  "]]>",
  "</",
  "<",
  ">",
  '"',
  "'",
  "=",
  " ",
  "\n",
  "\n\n",
  "&lt;",
  "&gt;",
  "&amp;",
  "&",
  "javascript:",
  "> [!NOTE]\n> ",
  "[^a]",
  "\n\n[^a]: ",
  "`",
  "*",
];
const hostileHtml = fc
  .array(
    fc.oneof({ weight: 4, arbitrary: fc.constantFrom(...TOKENS) }, fc.string({ maxLength: 4 })),
    {
      maxLength: 30,
    },
  )
  .map((parts) => parts.join(""));

/** DOMPurify on a string, serialized back the way the page would hold it. */
function purified(html: string): string {
  const box = document.createElement("div");
  box.append(purifyHtml(html));
  return box.innerHTML;
}

/** The server-side stage alone on raw HTML: rehype-raw, rehype-sanitize. Ids would be re-prefixed, so inputs carry none. */
function rehypeStage(html: string): string {
  const node: Html = { type: "html", value: html };
  return nodesToHtml([node], { loadRemoteImages: true });
}

/**
 * A fresh seed each run, so CI keeps exploring, printed so a failure can be
 * replayed: put the logged number here in place of the random one (fast-check
 * also prints the seed and shrink path of a failing case).
 */
const SEED = Math.floor(Math.random() * 2 ** 31);
console.info(`sanitize-twice property seed: ${SEED}`);

describe("sanitize twice changes nothing (decision 42)", () => {
  // Mutation XSS lives where a sanitizer's output, re-parsed, becomes a
  // different tree. If our output survives another pass unchanged, the
  // browser reading it builds the tree the sanitizer approved.
  fcTest.prop([hostileHtml], { numRuns: 300, seed: SEED })(
    "the full pipeline's output is a fixed point of DOMPurify",
    (input) => {
      const once = purified(nodesToHtml(parseMarkdown(input).children));
      expect(purified(once)).toBe(once);
      const host = document.createElement("div");
      host.innerHTML = once;
      expect(hazards(host)).toEqual([]);
    },
  );

  fcTest.prop([hostileHtml], { numRuns: 300, seed: SEED })(
    "rehype-sanitize's output is a fixed point of rehype-sanitize",
    (input) => {
      const once = rehypeStage(input);
      // An alert's own markup (the class on its <div>) is added after the
      // sanitizer on purpose and would be stripped by a second pass.
      fc.pre(!once.includes("markdown-alert"));
      // The sanitizer puts `user-content-` before every id, name and ARIA id
      // reference on each pass, as GitHub does, so those are not expected to
      // survive a second pass. Inputs carry none, but random text can make
      // one: hast reads a tag name like `a#x` as a selector, `<a id="x">`.
      fc.pre(!/\s(?:id|name|aria-describedby|aria-labelledby)="/.test(once));
      expect(rehypeStage(once)).toBe(once);
    },
  );

  // Found by the property above on about one CI run in 40. The schema
  // allows no <svg>, and unwrapping it left its SVG <summary> child inside
  // the <p>; re-parsed as HTML, a <summary> start tag closes the <p>, so the
  // second pass built a different tree. Foreign content now goes whole.
  for (const input of ["<p><svg><summary>", "<p><math><details>x", "<svg><p>a<summary>b"]) {
    test(`${input} renders the same tree when sanitized again`, () => {
      const once = rehypeStage(input);
      expect(rehypeStage(once)).toBe(once);
    });
  }

  // Found in review pass 2 with a wider alphabet than the property had. The
  // schema unwraps `<marquee>`, `<object>`, `<applet>`, `<button>` and every
  // other element it does not know; the parser had kept the `<p>`, `<li>` or
  // heading open across that element, so the unwrapped output nested a block
  // the browser closes on a re-parse. Stripping them would drop text GitHub
  // shows (`<u>`, `<center>`), so the stage re-parses its output until stable.
  const unwrapped: [input: string, text: string][] = [
    ["<p><marquee><dd>x", "x"],
    ["<p><object><li>x", "x"],
    ["<p><applet><hr>", ""],
    ["<p><marquee><h1>x", "x"],
    ["<p><button><dl>", ""],
    ["<h1><u><h2>x", "x"],
    ["<li><center><li>x", "x"],
    ["<dl><dd><figure><dd>x", "x"],
  ];
  for (const [input, text] of unwrapped) {
    test(`${input} renders the same tree when sanitized again, text kept`, () => {
      const once = rehypeStage(input);
      expect(rehypeStage(once)).toBe(once);
      expect(once).toContain(text);
    });
  }

  for (const [name, markdown] of Object.entries(CORPUS)) {
    test(`corpus: ${name} survives a second DOMPurify pass unchanged`, () => {
      const once = purified(nodesToHtml(parseMarkdown(markdown).children));
      expect(purified(once)).toBe(once);
    });
  }
});
