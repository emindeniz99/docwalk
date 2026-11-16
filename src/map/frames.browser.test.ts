import { afterEach, describe, expect, test } from "vitest";
import { page } from "vitest/browser";
// Same fonts as the app, so heights match what readers see.
import "@fontsource-variable/inter";
import "@fontsource-variable/jetbrains-mono";
import "virtual:docwalk-tokens.css";
import "../styles.css";
import fixture from "../../fixtures/ledger-redesign.md?raw";
import { purifyHtml } from "../deck/purify";
import { BLOCKED_IMAGE_CLASS, BLOCKED_IMAGE_SRC, nodesToHtml } from "../render/toHtml";
import { parseMarkdown } from "../sectioning/sectionize";
import { renderFrames, type MapFrames } from "./frames";
import { mapPlan } from "./layout";

/**
 * Decision 142, Frames, Measuring and Diagrams: the map draws one frame per
 * section of the map's plan with the slides' pipeline, reports each frame's
 * height once it has rendered (rule 4) and again when it changes, and draws
 * Mermaid only in the frames the view asks for.
 */

const handles: MapFrames[] = [];

afterEach(() => {
  for (const handle of handles.splice(0)) handle.dispose();
  document.body.replaceChildren();
});

interface Mounted {
  host: HTMLElement;
  handle: MapFrames;
  /** Every `onHeights` call, copied, in order. */
  reports: Map<string, number>[];
  navigations: [string, HTMLElement][];
}

/** Frames for `markdown` in a host under `parent`, once the first full set of heights is in. */
async function mount(markdown: string, parent: HTMLElement = document.body): Promise<Mounted> {
  const host = document.createElement("div");
  parent.append(host);
  const reports: Map<string, number>[] = [];
  const navigations: [string, HTMLElement][] = [];
  const handle = renderFrames(host, mapPlan(parseMarkdown(markdown)), {
    onHeights: (changed) => reports.push(new Map(changed)),
    onNavigate: (id, target) => navigations.push([id, target]),
  });
  handles.push(handle);
  await expect.poll(() => reports.length, { timeout: 20_000 }).toBeGreaterThan(0);
  return { host, handle, reports, navigations };
}

const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));

async function frames(n: number) {
  for (let i = 0; i < n; i++) await frame();
}

const bodyOf = (el: HTMLElement) => el.querySelector<HTMLElement>(".docwalk-slide-body")!;

const OUTLINE = [
  "# Guide",
  "",
  "Intro text.",
  "",
  "## Alpha",
  "",
  "Alpha text with a note.[^n]",
  "",
  "### Alpha detail",
  "",
  "Detail text.",
  "",
  "---",
  "",
  "A part after a break, with the same note.[^n]",
  "",
  "## Beta",
  "",
  "Beta text, see [the detail](#alpha-detail).",
  "",
  "[^n]: The note.",
  "",
].join("\n");

describe("frames stand in document order, named by their headings (decision 142, Frames)", () => {
  test("one section per plan section, in document order, each carrying its section id", async () => {
    // The view finds a frame by its id, and a screen reader and Tab read the frames in document order.
    const plan = mapPlan(parseMarkdown(OUTLINE));
    const { host } = await mount(OUTLINE);
    const sections = [...host.children] as HTMLElement[];
    expect(sections.every((s) => s.tagName === "SECTION")).toBe(true);
    expect(sections.map((s) => s.dataset["mapFrame"])).toEqual(plan.sections.map((s) => s.id));
    expect(sections.every((s) => s.classList.contains("docwalk-map-frame"))).toBe(true);
  });

  test("a frame's name is its heading's text; a part without a heading is named by its section's title", async () => {
    const plan = mapPlan(parseMarkdown(OUTLINE));
    const { host, handle } = await mount(OUTLINE);
    for (const section of plan.sections) {
      const el = handle.frames.get(section.id)!;
      expect(page.getByRole("region", { name: section.title, exact: true }).elements()).toContain(
        el,
      );
    }
    // The name comes from the rendered heading, whose anchor is the slide's (GitHub's prefix).
    const headed = plan.sections.filter((s) => s.heading);
    for (const section of headed) {
      const el = handle.frames.get(section.id)!;
      const heading = host.querySelector(`#${CSS.escape(el.getAttribute("aria-labelledby")!)}`)!;
      expect(heading.id).toBe(`user-content-${plan.headingIds.get(section.heading!)}`);
      expect(heading.tagName).toBe(`H${section.heading!.depth}`);
      expect(el.contains(heading)).toBe(true);
    }
    const parts = plan.sections.filter((s) => !s.heading);
    expect(parts.length).toBeGreaterThan(0);
    for (const section of parts) {
      expect(handle.frames.get(section.id)!.getAttribute("aria-label")).toBe(section.title);
    }
  });

  test("no two elements in the host share an id, with a footnote used in two frames and one diagram drawn twice", async () => {
    // axe reports duplicate ids only as "incomplete", so the test counts them itself.
    const diagram = "```mermaid\nflowchart LR\n  a --> b\n```";
    const markdown = `${OUTLINE}\n## Gamma\n\n${diagram}\n\n## Delta\n\n${diagram}\n`;
    const { host, handle } = await mount(markdown);
    await handle.drawDiagrams(["gamma", "delta"]);
    expect(host.querySelectorAll(".docwalk-diagram svg")).toHaveLength(2);
    const ids = [...host.querySelectorAll("[id]")].map((el) => el.id);
    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("hostile input comes out of a frame as it does out of the document view (rule 5)", () => {
  const HOSTILE = [
    "## Hostile",
    "",
    "<script>window.mapPwned = 1</script>",
    "",
    '<img src="x" onerror="window.mapPwned = 2">',
    "",
    "[click](javascript:window.mapPwned=3)",
    "",
    "![Chart](https://images.invalid/chart.png)",
    "",
  ].join("\n");

  test("the frame body holds exactly what the deck's sanitizing pipeline gives for the same nodes", () => {
    // Same pipeline, not a new one: before any async pass touches it, the body is that HTML.
    const plan = mapPlan(parseMarkdown(HOSTILE));
    const host = document.createElement("div");
    document.body.append(host);
    const handle = renderFrames(host, plan, {});
    handles.push(handle);
    const section = plan.sections[0]!;
    const expected = document.createElement("div");
    expected.append(
      purifyHtml(
        nodesToHtml([section.heading!, ...section.nodes], {
          footnotePrefix: `${section.id}-`,
          headingIds: plan.headingIds,
          definitions: plan.definitions,
        }),
      ),
    );
    expect(bodyOf(handle.frames.get(section.id)!).innerHTML).toBe(expected.innerHTML);
  });

  test("no script, no event handler, no javascript: link, and the remote image waits for a click", async () => {
    const { host } = await mount(HOSTILE);
    expect(host.querySelector("script")).toBeNull();
    for (const el of host.querySelectorAll("*")) {
      expect([...el.attributes].filter((a) => a.name.startsWith("on"))).toEqual([]);
    }
    for (const a of host.querySelectorAll("a[href]")) {
      expect(a.getAttribute("href")!.toLowerCase()).not.toContain("javascript:");
    }
    expect((window as { mapPwned?: number }).mapPwned).toBeUndefined();
    const img = host.querySelector<HTMLImageElement>('img[alt="Chart"]')!;
    expect(img.classList.contains(BLOCKED_IMAGE_CLASS)).toBe(true);
    expect(img.getAttribute("src")).toBeNull();
    // Click-to-load is wired: the click moves the URL into `src`.
    img.click();
    expect(img.getAttribute("src")).toBe("https://images.invalid/chart.png");
    expect(img.hasAttribute(BLOCKED_IMAGE_SRC)).toBe(false);
  });
});

describe("links to headings (decision 142, Frames)", () => {
  test("a link to a heading in another frame focuses that heading and names its frame for the camera", async () => {
    const { host, navigations } = await mount(OUTLINE);
    const link = host.querySelector<HTMLAnchorElement>(
      '[data-map-frame="beta"] a[href="#alpha-detail"]',
    )!;
    link.click();
    const heading = host.querySelector<HTMLElement>("#user-content-alpha-detail")!;
    expect(document.activeElement).toBe(heading);
    expect(navigations).toEqual([["alpha-detail", heading]]);
  });
});

const SHORT_LONG = [
  "## Short",
  "",
  "One line.",
  "",
  "## Long",
  "",
  ...Array.from({ length: 20 }, (_, i) => `Paragraph ${i + 1} of the long frame.\n`),
].join("\n");

describe("heights (decision 142, Measuring)", () => {
  test("every frame has a height in the first report, and more content makes a taller frame", async () => {
    const { reports } = await mount(SHORT_LONG);
    const [first] = reports;
    expect([...first!.keys()]).toEqual(["short", "long"]);
    expect(first!.get("short")).toBeGreaterThan(0);
    expect(first!.get("long")).toBeGreaterThan(first!.get("short")!);
  });

  test("the height is the frame's own, the same under an ancestor scaled to half", async () => {
    // The view scales the layer; a height read from client rects would come out halved.
    const scaled = document.createElement("div");
    scaled.style.transform = "scale(0.5)";
    document.body.append(scaled);
    const plain = await mount(SHORT_LONG);
    const small = await mount(SHORT_LONG, scaled);
    expect(small.reports[0]).toEqual(plain.reports[0]);
  });

  test("content that grows after the first report is reported once, for that frame only", async () => {
    const { handle, reports } = await mount(SHORT_LONG);
    const before = reports[0]!.get("short")!;
    const more = document.createElement("p");
    more.textContent = "A late block. ".repeat(80);
    bodyOf(handle.frames.get("short")!).append(more);
    await expect.poll(() => reports.length).toBe(2);
    expect([...reports[1]!.keys()]).toEqual(["short"]);
    expect(reports[1]!.get("short")).toBeGreaterThan(before);
    expect(handle.measure("short")).toBe(reports[1]!.get("short"));
    await frames(3);
    expect(reports).toHaveLength(2);
  });

  test("nothing is reported after dispose", async () => {
    const { handle, reports } = await mount(SHORT_LONG);
    const body = bodyOf(handle.frames.get("short")!);
    handle.dispose();
    const more = document.createElement("p");
    more.textContent = "A late block. ".repeat(80);
    body.append(more);
    await frames(4);
    expect(reports).toHaveLength(1);
  });

  test("nothing is reported after a dispose that comes before the first report", async () => {
    // An edit re-renders the frames while the old ones are still settling.
    const host = document.createElement("div");
    document.body.append(host);
    let calls = 0;
    const handle = renderFrames(host, mapPlan(parseMarkdown(SHORT_LONG)), {
      onHeights: () => calls++,
    });
    handle.dispose();
    await frames(6);
    expect(calls).toBe(0);
  });
});

describe("code, math and emoji are drawn in frames as on a slide (decision 142, Frames)", () => {
  test("a code block is coloured, a formula is MathML and a shortcode is an emoji by the first report", async () => {
    const markdown = [
      "## Code",
      "",
      "```ts",
      "const answer = 42; // comment",
      "```",
      "",
      "## Math",
      "",
      "Ship it :rocket: once $E=mc^2$ holds.",
      "",
      "$$",
      "a^2 + b^2 = c^2",
      "$$",
      "",
    ].join("\n");
    const { handle } = await mount(markdown);
    const code = handle.frames.get("code")!;
    expect(code.querySelector("pre code span.dw-code-keyword")).not.toBeNull();
    const math = handle.frames.get("math")!;
    expect(math.querySelectorAll("code.language-math")).toHaveLength(0);
    expect(math.querySelector("p > math msup")).not.toBeNull();
    expect(math.querySelector("p")!.textContent).toBe("Ship it 🚀 once E=mc2 holds.");
  });
});

describe("diagrams are drawn only where the view asks (decision 142, Diagrams)", () => {
  const DIAGRAMS = [
    "## First",
    "",
    "```mermaid",
    "flowchart TD",
    "  a --> b",
    "  b --> c",
    "  c --> d",
    "  d --> e",
    "```",
    "",
    "| Name | Value |",
    "| --- | --- |",
    "| a | 1 |",
    "",
    "## Second",
    "",
    "```mermaid",
    "flowchart LR",
    "  x --> y",
    "```",
    "",
    "## Plain",
    "",
    "```ts",
    "const a = 1;",
    "```",
    "",
  ].join("\n");

  test("no diagram is drawn by renderFrames; drawDiagrams draws the frames named and no other", async () => {
    const { host, handle } = await mount(DIAGRAMS);
    expect(host.querySelector(".docwalk-diagram")).toBeNull();
    expect(host.querySelectorAll("pre > code.language-mermaid")).toHaveLength(2);
    await handle.drawDiagrams(["first"]);
    expect(handle.frames.get("first")!.querySelector(".docwalk-diagram svg")).not.toBeNull();
    expect(handle.frames.get("second")!.querySelector(".docwalk-diagram")).toBeNull();
    expect(
      handle.frames.get("second")!.querySelector("pre > code.language-mermaid"),
    ).not.toBeNull();
  });

  test("a second call for the same frame draws nothing again", async () => {
    const { handle } = await mount(DIAGRAMS);
    await handle.drawDiagrams(["first"]);
    const svg = handle.frames.get("first")!.querySelector(".docwalk-diagram svg");
    await handle.drawDiagrams(["first"]);
    expect(handle.frames.get("first")!.querySelectorAll(".docwalk-diagram")).toHaveLength(1);
    expect(handle.frames.get("first")!.querySelector(".docwalk-diagram svg")).toBe(svg);
  });

  test("a frame drawn later is measured again, and only that frame is reported", async () => {
    // A five-node top-down chart stands taller than its five-line source.
    const { handle, reports } = await mount(DIAGRAMS);
    const before = reports[0]!.get("first")!;
    await handle.drawDiagrams(["first"]);
    await expect.poll(() => reports.length).toBeGreaterThan(1);
    await frames(3);
    const later = reports.slice(1);
    expect(later.every((r) => [...r.keys()].every((id) => id === "first"))).toBe(true);
    expect(later.at(-1)!.get("first")).toBeGreaterThan(before);
    expect(later.at(-1)!.get("first")).toBe(handle.measure("first"));
  });

  test("a frame's blocks become focus targets once its diagrams are drawn, a frame with none too", async () => {
    // Marked after the diagrams, as the document view does: a diagram's source is no code block.
    const { host, handle } = await mount(DIAGRAMS);
    expect(host.querySelector("[data-docwalk-focus]")).toBeNull();
    await handle.drawDiagrams(["first"]);
    expect(handle.frames.get("first")!.querySelector("table")!.dataset["docwalkFocus"]).toBe(
      "table",
    );
    expect(handle.frames.get("second")!.querySelector("[data-docwalk-focus]")).toBeNull();
    expect(handle.frames.get("plain")!.querySelector("[data-docwalk-focus]")).toBeNull();
    await handle.drawDiagrams(["plain"]);
    expect(handle.frames.get("plain")!.querySelector("pre")!.dataset["docwalkFocus"]).toBe("code");
  });
});

describe("documents at the edges", () => {
  test("a document with no headings is one frame, with a height", async () => {
    const plan = mapPlan(parseMarkdown("Just text.\n\nMore text.\n"));
    const { host, reports } = await mount("Just text.\n\nMore text.\n");
    expect(plan.sections).toHaveLength(1);
    expect(host.querySelectorAll("section[data-map-frame]")).toHaveLength(1);
    expect(reports[0]!.get(plan.sections[0]!.id)).toBeGreaterThan(0);
  });

  test("an empty document has no frames and still reports, with no heights", async () => {
    // The view waits for the first report before it places anything.
    const { host, reports } = await mount("");
    expect(host.children).toHaveLength(0);
    expect(reports[0]!.size).toBe(0);
  });

  test(
    "the acceptance fixture: forty frames, every one with a positive height",
    { timeout: 60_000 },
    async () => {
      const plan = mapPlan(parseMarkdown(fixture));
      const started = performance.now();
      const { reports, handle } = await mount(fixture);
      const elapsed = performance.now() - started;
      expect(plan.sections).toHaveLength(40);
      expect(handle.frames.size).toBe(40);
      expect([...reports[0]!.keys()]).toEqual(plan.sections.map((s) => s.id));
      for (const height of reports[0]!.values()) expect(height).toBeGreaterThan(0);
      console.info(`ledger fixture: 40 frames rendered and measured in ${Math.round(elapsed)} ms`);
    },
  );
});
