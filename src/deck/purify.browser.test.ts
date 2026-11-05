import { afterEach, describe, expect, test } from "vitest";
import { prepareDiagramSource, renderDiagram } from "./mermaid";
import { purifySvg } from "./purify";

afterEach(() => {
  document.body.replaceChildren();
});

/** themeCSS in front matter would put attacker CSS into the diagram's <style>. */
const THEME_CSS =
  "config:\n  themeCSS: \".node rect { background-image: image-set('https://evil.invalid/7.png' 1x) }\"\n";

describe("Mermaid front matter is stripped the way Mermaid reads it (decision 26)", () => {
  // Mermaid 12 accepts whitespace after the opening `---` (and CRLF); a strip
  // that wants `---\n` exactly let the config through, and with it themeCSS.
  const variants = {
    plain: `---\n${THEME_CSS}---\nflowchart LR\n  A-->B`,
    "trailing space after the opening fence": `--- \n${THEME_CSS}---\nflowchart LR\n  A-->B`,
    "tab after the opening fence": `---\t\n${THEME_CSS}---\nflowchart LR\n  A-->B`,
    "trailing space after the closing fence": `---\n${THEME_CSS}--- \nflowchart LR\n  A-->B`,
    CRLF: `---\r\n${THEME_CSS.replaceAll("\n", "\r\n")}---\r\nflowchart LR\r\n  A-->B`,
    "indented fences": `  ---\n${THEME_CSS}  ---\nflowchart LR\n  A-->B`,
    // An indented `---` ends this strip earlier than Mermaid would end the
    // block; what follows must not be left as a second block for Mermaid.
    "indented fence inside the block": `---\nx: 1\n  ---\n---\n${THEME_CSS}---\nflowchart LR\n  A-->B`,
  };

  for (const [name, source] of Object.entries(variants)) {
    test(`${name}: no config reaches Mermaid`, () => {
      const cleaned = prepareDiagramSource(source);
      expect(cleaned).not.toMatch(/themeCSS|evil\.invalid/);
      expect(cleaned.trimStart().startsWith("---")).toBe(false);
      expect(cleaned).toMatch(/flowchart LR/);
    });
  }

  test("the trailing-space bypass renders without fetching anything", async () => {
    const host = document.createElement("figure");
    document.body.append(host);
    const result = await renderDiagram(host, variants["trailing space after the opening fence"]);
    expect(result.ok).toBe(true);
    expect(host.innerHTML).not.toContain("evil.invalid");
  });
});

const svgWith = (css: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><style>${css}</style><rect width="5" height="5"/></svg>`;
const styleOf = (css: string) => purifySvg(svgWith(css)).querySelector("style")?.textContent ?? "";

describe("purifySvg drops CSS that can fetch", () => {
  // Mermaid's own CSS is a known shape, but a diagram's config or a pre-pass
  // gap can still smuggle rules in; the sanitizer is the last line.
  const fetching = {
    "url()": ".a { background: url(https://evil.invalid/1.png) }",
    "image-set()": ".a { background-image: image-set('https://evil.invalid/2.png' 1x) }",
    "-webkit-image-set()":
      ".a { background-image: -webkit-image-set('https://evil.invalid/3.png' 1x) }",
    "@import": "@import 'https://evil.invalid/4.css'; .b { fill: red }",
    "escaped url": ".a { background: u\\72l(https://evil.invalid/5.png) }",
    "escaped url in a custom property":
      ".a { --x: u\\72l(https://evil.invalid/6.png); background: var(--x) }",
    "@font-face": "@font-face { font-family: x; src: url(https://evil.invalid/7.woff2) }",
  };

  for (const [name, css] of Object.entries(fetching)) {
    test(`${name} does not survive`, () => {
      expect(styleOf(css)).not.toContain("evil.invalid");
    });
  }

  test("ordinary rules survive, so diagrams keep their look", () => {
    const css = styleOf(
      "#m .node rect { fill: #ececff; stroke: #9370db } #m .edgePath path { stroke-width: 2px }",
    );
    expect(css).toContain(".node rect");
    expect(css).toContain(".edgePath path");
  });

  test("a real Mermaid diagram keeps every rule of its stylesheet", async () => {
    const host = document.createElement("figure");
    document.body.append(host);
    await renderDiagram(host, "flowchart LR\n  A[Ledger] --> B{Journal}\n  B --> C((Done))");
    const rules = host.querySelector("style")?.textContent ?? "";
    expect(rules).toMatch(/\.node rect/);
    expect(rules.length).toBeGreaterThan(1000);
  });
});
