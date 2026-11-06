import { afterEach, describe, expect, test } from "vitest";
import fixture from "../../fixtures/ledger-redesign.md?raw";
import { parseMarkdown, sectionize } from "../sectioning/sectionize";
// Same fonts as the app, so measurements and pagination match what users see.
import "@fontsource-variable/bricolage-grotesque";
import "@fontsource-variable/inter";
import "@fontsource-variable/jetbrains-mono";
import "virtual:docwalk-tokens.css";
import "../styles.css";
import { BLOCKED_IMAGE_CLASS } from "../render/toHtml";
import { fitDiagrams, measureBody, measureOffscreen, settled, slideBodySize } from "./measure";
import { prepareDiagramSource, renderDiagrams } from "./mermaid";
import { buildSlide, buildSlides } from "./slides";

const SIZE = { width: 1280, height: 720 };

const chain = (n: number) =>
  Array.from({ length: n }, (_, i) => `  n${i} --> n${i + 1}`).join("\n");

afterEach(() => {
  document.body.replaceChildren();
});

/** A laid-out slide of the given size, so measurements are real. */
function mountSlide(markdown: string, size = SIZE): HTMLElement {
  const plan = sectionize(parseMarkdown(markdown));
  const section = buildSlide(plan.sections[0] as never);
  const frame = document.createElement("div");
  Object.assign(frame.style, { width: `${size.width}px`, height: `${size.height}px` });
  frame.append(section);
  document.body.append(frame);
  return section.querySelector(".docwalk-slide-body") as HTMLElement;
}

describe("overflow measurement (real layout, never jsdom)", () => {
  test("a section taller than the slide is reported, with how much it overflows", () => {
    const body = mountSlide(`## Long\n\n${"A paragraph of text.\n\n".repeat(80)}`);
    const m = measureBody(body);
    expect(m.overflows).toBe(true);
    expect(m.body.y).toBeGreaterThan(500);
  });

  test("a section that fits raises no diagnostic", () => {
    expect(measureBody(mountSlide("## Short\n\nOne line.\n")).overflows).toBe(false);
  });

  test("a clipped diagram is reported even when the slide body itself fits", async () => {
    // Diagram hosts clip their own content, so the body check alone would pass this slide.
    const body = mountSlide("## Diagram\n\n```mermaid\nflowchart TB\n" + chain(30) + "\n```\n");
    await renderDiagrams(body);
    const host = body.querySelector(".docwalk-diagram") as HTMLElement;
    host.style.maxHeight = "200px"; // simulate a host that clips, without fitting
    await settled(body);
    const m = measureBody(body);
    expect(m.body.y).toBe(0);
    expect(m.diagrams[0]?.y ?? 0).toBeGreaterThan(0);
    expect(m.overflows).toBe(true);
  });

  test("a tall diagram is scaled to fit the slide and flagged as too small to read", async () => {
    const body = mountSlide("## Diagram\n\n```mermaid\nflowchart TB\n" + chain(30) + "\n```\n");
    await renderDiagrams(body);
    fitDiagrams(body, slideBodySize(SIZE));
    await settled(body);
    const m = measureBody(body);
    expect(m.overflows).toBe(false); // fitted, so nothing is clipped
    expect(m.tooSmall).toBe(1); // but too small to read: the presenter is told to open it
  });

  test("a small diagram keeps its natural size", async () => {
    const body = mountSlide("## Diagram\n\n```mermaid\nflowchart LR\n  a --> b\n```\n");
    await renderDiagrams(body);
    fitDiagrams(body, slideBodySize(SIZE));
    const host = body.querySelector(".docwalk-diagram") as HTMLElement;
    expect(host.dataset["scale"]).toBe("1.000");
    expect(measureBody(body).tooSmall).toBe(0);
  });

  test("hidden slides measure like visible ones in the off-screen box", () => {
    const body = mountSlide(`## Long\n\n${"Text.\n\n".repeat(80)}`);
    const section = body.closest("section") as HTMLElement;
    section.style.display = "none"; // what reveal.js does to distant slides
    expect(measureBody(body).body.y).toBe(0);
    const [m] = measureOffscreen([body], SIZE);
    expect(m?.body.y).toBeGreaterThan(500);
  });
});

describe("hostile input", () => {
  test("event handlers and javascript: links never reach the DOM", () => {
    const body = mountSlide(
      '## XSS\n\n<img src="x" onerror="alert(1)">\n\n[click](javascript:alert(1))\n\n<script>alert(1)</script>\n',
    );
    expect(body.innerHTML).not.toMatch(/onerror|<script|javascript:/i);
  });

  test("remote images wait for the viewer: src moves to data-docwalk-src", () => {
    const body = mountSlide("## Img\n\n![sketch](https://example.com/a.png)\n");
    const img = body.querySelector("img") as HTMLImageElement;
    expect(img.getAttribute("src")).toBeNull();
    expect(img.getAttribute("data-docwalk-src")).toBe("https://example.com/a.png");
    expect(img.classList.contains(BLOCKED_IMAGE_CLASS)).toBe(true);
  });

  test("a diagram cannot raise its own security level or fetch CSS images", () => {
    // Image shapes are refused after Mermaid parses them (src/render/privacy.browser.test.ts).
    const source = [
      '%%{init: {"securityLevel": "loose"}}%%',
      "flowchart LR",
      "  a --> b",
      "  style b fill:url(https://example.com/p.svg)",
    ].join("\n");
    const cleaned = prepareDiagramSource(source);
    expect(cleaned).not.toMatch(/securityLevel|example\.com/);
  });

  test("rendered diagrams contain no script, foreignObject, external image or link", async () => {
    const body = mountSlide(
      '## D\n\n```mermaid\nflowchart LR\n  a["<img src=x onerror=alert(1)>"] --> b\n  click a "javascript:alert(1)"\n```\n',
    );
    await renderDiagrams(body);
    const svg = body.querySelector("svg") as SVGSVGElement;
    expect(svg).not.toBeNull();
    // Inspect live elements and attributes: escaped label text like "&lt;img" is harmless.
    expect(svg.querySelector("script, foreignObject, image, a")).toBeNull();
    for (const el of [svg, ...svg.querySelectorAll("*")]) {
      for (const attr of el.attributes) {
        expect(attr.name).not.toMatch(/^on/i);
        expect(attr.value).not.toMatch(/^\s*javascript:/i);
      }
    }
    // strict mode drops the click binding entirely.
    expect(svg.querySelector(".clickable")?.getAttribute("onclick") ?? null).toBeNull();
  });
});

describe("diagram hosts and assistive technology", () => {
  test("a diagram is a focusable group, so its own labels stay readable", async () => {
    // role=button made the diagram's text presentational: a screen reader
    // heard "Diagram, button" and none of the boxes or arrows (axe: WCAG 2.5.3).
    const body = mountSlide("## D\n\n```mermaid\nflowchart LR\n  Ledger --> Journal\n```\n");
    await renderDiagrams(body);
    const host = body.querySelector<HTMLElement>(".docwalk-diagram") as HTMLElement;
    expect(host.getAttribute("role")).toBe("group");
    expect(host.tabIndex).toBe(0);
    expect(host.getAttribute("aria-label")).toMatch(/Enter/);
    expect(host.textContent).toContain("Journal");
  });
});

describe("acceptance fixture", () => {
  test("every diagram renders, and the dense slides are flagged instead of clipped silently", async () => {
    const plan = sectionize(parseMarkdown(fixture));
    const slides = buildSlides(plan);
    const container = document.createElement("div");
    container.append(...slides);
    document.body.append(container);

    const results = await renderDiagrams(container);
    expect(results).toHaveLength(7);
    expect(results.filter((r) => !r.ok)).toEqual([]);

    fitDiagrams(container, slideBodySize(SIZE));
    await settled(container);
    const bodies = slides.map((s) => s.querySelector(".docwalk-slide-body") as HTMLElement);
    const measurements = measureOffscreen(bodies, SIZE);
    const overflowing = slides
      .filter((_, i) => measurements[i]?.overflows)
      .map((s) => s.dataset["docwalkId"]);

    // The 40-row flag table and the 22-item list cannot fit one 16:9 slide.
    expect(overflowing).toContain("configuration-flags");
    expect(overflowing).toContain("problems-with-the-current-system");
    // A one-paragraph section must not be flagged.
    expect(overflowing).not.toContain("summary");
    // The dense appendix diagram sits after the setext trap, which starts its own
    // slide; it is fitted, then flagged as too small to read.
    const dense = slides.findIndex((s) =>
      s.dataset["docwalkId"]?.startsWith("the-next-line-is-three-hyphens"),
    );
    expect(measurements[dense]?.tooSmall).toBe(1);
    // The 30-node proposed architecture fits only at about a quarter size.
    const proposed = slides.findIndex((s) => s.dataset["docwalkId"] === "proposed-architecture");
    expect(measurements[proposed]?.tooSmall).toBe(1);
    // A small gantt chart stays at natural size.
    const gantt = slides.findIndex((s) => s.dataset["docwalkId"] === "migration-plan");
    expect(measurements[gantt]?.tooSmall).toBe(0);
  });
});
