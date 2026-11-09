import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, test, vi } from "vitest";
import { userEvent } from "vitest/browser";
import "virtual:docwalk-tokens.css";
import "../styles.css";
import fontUrl from "@fontsource-variable/inter/files/inter-latin-wght-normal.woff2?url";
import type { SavedStroke } from "../annotate/savedMarks";
import { inlineFonts, sameOriginRules } from "./css";
import { ExportMenu } from "./ExportMenu";
import { EXPORT_CSP, exportHtml } from "./html";
import { exportPng, refuseForeignImages, type PngFile } from "./png";
import { printDeck } from "./print";
import type { ExportOptions, ExportSlide } from "./types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SIZE = { width: 1280, height: 720 };

/**
 * Slides shaped like the deck's (`section[data-docwalk-id] > .docwalk-slide`),
 * built in a <template> so remote images in them never load while the test
 * sets up: any request seen later was made by the exporter.
 */
function slide(id: string, title: string, extra = ""): ExportSlide {
  const template = document.createElement("template");
  template.innerHTML = `
    <section data-docwalk-id="${id}" data-page="1" class="present" style="display: block; top: 0px">
      <div class="docwalk-slide">
        <nav class="docwalk-breadcrumb" aria-label="Section path">Design</nav>
        <div class="docwalk-slide-body"><h2>${title}</h2><p>Body of ${title}.</p>${extra}</div>
        <p class="docwalk-overflow" role="status" hidden></p>
      </div>
    </section>`;
  return {
    address: `${id}/1`,
    title,
    element: template.content.firstElementChild as HTMLElement,
  };
}

const DIAGRAM = `
  <figure class="docwalk-diagram" tabindex="0" role="button" aria-label="Diagram. Press Enter to open it full screen."
    data-source="flowchart LR; A-->B; click A href 'https://example.com'">
    <svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 100 40" style="width: 100px">
      <style>.edge { stroke: currentColor } .bg { fill: url(https://tracker.example/fill.svg) }</style>
      <defs><marker id="arrow"><path d="M0,0 L4,2 L0,4"></path></marker></defs>
      <path class="edge" d="M5,20 L90,20" marker-end="url(#arrow)"></path>
      <text x="5" y="12">Ledger</text>
      <use href="https://tracker.example/sprite.svg#x"></use>
    </svg>
  </figure>`;

const HOSTILE = `
  <p><a href="https://example.com/spec">the spec</a> and <a href="javascript:alert(1)">a trap</a></p>
  <img class="docwalk-blocked-image" alt="Blocked chart" data-docwalk-src="https://images.example/chart.png">
  <img alt="Loaded chart" src="https://images.example/loaded.png" srcset="https://images.example/2x.png 2x" loading="lazy">
  <p onclick="alert(1)" style="background: url(https://tracker.example/bg.png)">Click</p>
  <script>alert(1)</script>`;

function deck(...slides: ExportSlide[]): ExportOptions {
  return { title: "Ledger <b>redesign</b> & plan", slides, size: SIZE };
}

async function parseExport(options: ExportOptions): Promise<{ text: string; doc: Document }> {
  const blob = await exportHtml(options);
  const text = await blob.text();
  return { text, doc: new DOMParser().parseFromString(text, "text/html") };
}

/** Requests the page made after `since` (ms) to anything that is not this origin or a data: URL. */
function foreignRequests(since: number): string[] {
  return performance
    .getEntriesByType("resource")
    .filter((e) => e.startTime >= since)
    .map((e) => e.name)
    .filter((name) => !name.startsWith(location.origin) && !name.startsWith("data:"));
}

describe("exportHtml", () => {
  test("is one parseable HTML document holding every slide title, in order", async () => {
    const titles = ["Context", "Data model", "Rollout"];
    const { doc, text } = await parseExport(deck(...titles.map((t, i) => slide(`s${i}`, t))));
    expect(text.startsWith("<!doctype html>")).toBe(true);
    const pages = [...doc.querySelectorAll(".docwalk-export-page")];
    expect(pages).toHaveLength(3);
    expect(pages.map((p) => p.querySelector("h2")?.textContent)).toEqual(titles);
  });

  test("carries a strict CSP as the first thing after the charset, so the browser refuses anything that slipped through", async () => {
    const { doc } = await parseExport(deck(slide("a", "A")));
    const head = [...doc.head.children];
    expect(head[0]?.getAttribute("charset")).toBe("utf-8");
    expect(head[1]?.getAttribute("http-equiv")).toBe("Content-Security-Policy");
    expect(head[1]?.getAttribute("content")).toBe(EXPORT_CSP);
    expect(EXPORT_CSP).toContain("default-src 'none'");
  });

  test("has no scripts, no event-handler attributes and no javascript: links, even when the slide carried them", async () => {
    const { doc } = await parseExport(deck(slide("a", "Hostile", HOSTILE)));
    expect(doc.querySelectorAll("script")).toHaveLength(0);
    const handlers = [...doc.querySelectorAll("*")].flatMap((el) =>
      [...el.attributes].filter((a) => a.name.toLowerCase().startsWith("on")).map((a) => a.name),
    );
    expect(handlers).toEqual([]);
    expect(doc.querySelector('a[href^="javascript"]')).toBeNull();
    expect(doc.body.textContent).toContain("Click");
  });

  test("contains no http(s) URL except the document's own links, so opening it offline makes no request", async () => {
    const { doc, text } = await parseExport(deck(slide("a", "Remote", HOSTILE + DIAGRAM)));
    const links = [...doc.querySelectorAll("a[href]")].map((a) => a.getAttribute("href"));
    expect(links).toEqual(["https://example.com/spec"]);
    // Links stay (they are the document's words) but never send a referrer.
    expect(doc.querySelector("a")?.getAttribute("rel")).toBe("noopener noreferrer");
    let rest = text;
    for (const href of links) rest = rest.replaceAll(`href="${href}"`, "");
    expect(rest.match(/https?:\/\/[^\s"')<]*/g) ?? []).toEqual([]);
  });

  test("blocked and loaded remote images both end up as blocked placeholders with their alt text", async () => {
    const { doc } = await parseExport(deck(slide("a", "Images", HOSTILE)));
    const images = [...doc.querySelectorAll("img")];
    expect(images.map((i) => i.alt)).toEqual(["Blocked chart", "Loaded chart"]);
    for (const img of images) {
      expect(img.classList.contains("docwalk-blocked-image")).toBe(true);
      expect(img.hasAttribute("src") || img.hasAttribute("data-docwalk-src")).toBe(false);
    }
  });

  test("diagrams stay inline SVG with their markers, but lose the button role nothing can press", async () => {
    const { doc } = await parseExport(deck(slide("a", "Diagram", DIAGRAM)));
    const figure = doc.querySelector(".docwalk-diagram");
    expect(figure?.querySelector("svg text")?.textContent).toBe("Ledger");
    expect(figure?.querySelector("path.edge")?.getAttribute("marker-end")).toBe("url(#arrow)");
    expect(figure?.getAttribute("role")).toBeNull();
    expect(figure?.hasAttribute("tabindex")).toBe(false);
    // An external <use> would fetch its sprite; DOMPurify drops the element or the hook drops its href.
    expect(figure?.querySelector("use[href], use[*|href]")).toBeNull();
  });

  test("the title is text, never markup, and reveal.js's live-state styles are gone", async () => {
    const { doc } = await parseExport(deck(slide("a", "A")));
    expect(doc.title).toBe("Ledger <b>redesign</b> & plan");
    expect(doc.head.querySelector("b")).toBeNull();
    const section = doc.querySelector("section[data-docwalk-id]");
    expect(section?.getAttribute("style")).toBeNull();
    expect(section?.classList.contains("present")).toBe(false);
    // A hidden diagnostic would print as an empty yellow box.
    expect(doc.querySelector(".docwalk-overflow")).toBeNull();
  });

  test("inlines the app's CSS, so the file looks like the deck without the app", async () => {
    const { doc } = await parseExport(deck(slide("a", "A")));
    const css = doc.querySelector("style")?.textContent ?? "";
    expect(css).toContain(".docwalk-slide");
    expect(css).toContain("--dw-color-slide");
    expect(css).toContain("@page { size: 1280px 720px; margin: 0; }");
    expect(doc.documentElement.dataset["theme"]).toBe("light");
  });

  test("embeds a self-hosted font as a data: URL when it is under budget", async () => {
    const style = document.createElement("style");
    style.textContent = `@font-face { font-family: "Export Test"; src: url("${fontUrl}") format("woff2"); unicode-range: U+0000-00FF; }`;
    document.head.append(style);
    try {
      const { doc } = await parseExport(deck(slide("a", "Fonts")));
      const css = doc.querySelector("style")?.textContent ?? "";
      expect(css).toMatch(/@font-face \{ src: url\("data:font\/woff2;base64,[A-Za-z0-9+/=]+"\)/);
      expect(css).toContain("Fonts embedded as data: URLs");
    } finally {
      style.remove();
    }
  });

  test("falls back to the system font stack, and says so, when the fonts pass the budget", async () => {
    const style = document.createElement("style");
    style.textContent = `@font-face { font-family: "Export Test"; src: url("${fontUrl}") format("woff2"); }`;
    document.head.append(style);
    try {
      const fonts = await inlineFonts(sameOriginRules(document), "Hi", 1000);
      expect(fonts.css).toBe("");
      expect(fonts.note).toContain("system font stack");
    } finally {
      style.remove();
    }
  });

  test("a font URL that answers with something other than a font is not embedded", async () => {
    // A static host serves its index.html with a 200 for a missing file.
    const style = document.createElement("style");
    style.textContent = `@font-face { font-family: "Export Test"; src: url("/") format("woff2"); }`;
    document.head.append(style);
    try {
      const fonts = await inlineFonts(sameOriginRules(document), "Hi", 1_500_000);
      expect(fonts.css).toBe("");
    } finally {
      style.remove();
    }
  });
});

describe("printDeck", () => {
  afterEach(() => document.querySelectorAll("iframe").forEach((f) => f.remove()));

  test("prints a hidden frame with one 1280x720 page per slide and removes it after printing", async () => {
    let seen: {
      pages: number;
      breaks: string[];
      sizes: string[];
      pageRule: string;
      inDom: boolean;
    } | null = null;
    await printDeck(deck(slide("a", "One"), slide("b", "Two"), slide("c", "Three")), (win) => {
      const doc = win.document;
      const pages = [...doc.querySelectorAll<HTMLElement>(".docwalk-export-page")];
      const pageRule = [...doc.styleSheets]
        .flatMap((s) => [...s.cssRules])
        // The frame is another realm, so `instanceof CSSPageRule` would be false.
        .find((r): r is CSSPageRule => r.cssText.startsWith("@page"));
      seen = {
        pages: pages.length,
        breaks: pages.map((p) => win.getComputedStyle(p).breakBefore),
        sizes: pages.map((p) => `${p.offsetWidth}x${p.offsetHeight}`),
        pageRule: pageRule?.style.getPropertyValue("size") ?? "",
        inDom: document.querySelector("iframe[data-docwalk-print]") !== null,
      };
      win.dispatchEvent(new Event("afterprint"));
    });
    expect(seen).toEqual({
      pages: 3,
      // A page break before every slide but the first: one slide per printed page.
      breaks: ["auto", "page", "page"],
      sizes: ["1280x720", "1280x720", "1280x720"],
      pageRule: "1280px 720px",
      inDom: true,
    });
    expect(document.querySelector("iframe[data-docwalk-print]")).toBeNull();
  });

  test("the frame copies the app's styles, so slides print in the deck's look", async () => {
    let background = "";
    await printDeck(deck(slide("a", "One")), (win) => {
      const slideEl = win.document.querySelector<HTMLElement>(".docwalk-slide")!;
      background = win.getComputedStyle(slideEl).backgroundColor;
      win.dispatchEvent(new Event("afterprint"));
    });
    const probe = document.createElement("div");
    probe.style.background = "var(--dw-color-slide)";
    document.body.append(probe);
    expect(background).toBe(getComputedStyle(probe).backgroundColor);
    probe.remove();
  });

  test("the frame lays slides out in standards mode, as the stage was measured, so a table keeps the slide's line height", async () => {
    // A bare iframe holds about:blank, which is in quirks mode: tables reset
    // line-height to `normal`, so printed pages would not match the measured stage.
    let seen = { mode: "", lineHeight: "" };
    const table = "<table><tbody><tr><td>Cell</td></tr></tbody></table>";
    await printDeck(deck(slide("a", "Table", table)), (win) => {
      const cell = win.document.querySelector("td")!;
      seen = { mode: win.document.compatMode, lineHeight: win.getComputedStyle(cell).lineHeight };
      win.dispatchEvent(new Event("afterprint"));
    });
    expect(seen.mode).toBe("CSS1Compat");
    expect(seen.lineHeight).not.toBe("normal");
  });

  test("a frame left behind by a browser that never fired afterprint is cleared by the next print", async () => {
    await printDeck(deck(slide("a", "One")), () => undefined);
    expect(document.querySelectorAll("iframe[data-docwalk-print]")).toHaveLength(1);
    // Until then it sits in the page: its links must not take keyboard focus.
    expect(document.querySelector<HTMLIFrameElement>("iframe[data-docwalk-print]")?.inert).toBe(
      true,
    );
    await printDeck(deck(slide("a", "One")), () => undefined);
    expect(document.querySelectorAll("iframe[data-docwalk-print]")).toHaveLength(1);
  });
});

describe("exportPng", () => {
  test("renders a slide to a 2x PNG named after its address, without any request off this origin", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const since = performance.now();
    const saved: PngFile[] = [];
    const files = await exportPng(
      { title: "T", slides: [slide("data-model", "Data model", HOSTILE + DIAGRAM)], size: SIZE },
      { save: (file) => void saved.push(file) },
    );
    expect(files).toEqual(saved);
    expect(files.map((f) => f.name)).toEqual(["1-data-model-1.png"]);
    const bytes = new Uint8Array(await files[0]!.blob.arrayBuffer());
    // The PNG signature, then IHDR width and height (big-endian) at 2x the slide.
    expect(Array.from(bytes.subarray(0, 8))).toEqual([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    const view = new DataView(bytes.buffer);
    expect([view.getUint32(16), view.getUint32(20)]).toEqual([2560, 1440]);

    const fetched = fetchSpy.mock.calls.map(([input]) =>
      String(input instanceof Request ? input.url : input),
    );
    expect(
      fetched.filter((u) => !new URL(u, location.href).href.startsWith(location.origin)),
    ).toEqual([]);
    expect(foreignRequests(since)).toEqual([]);
    expect(document.querySelector(".docwalk-export-capture")).toBeNull();
    fetchSpy.mockRestore();
  });

  test("while a slide is captured, its links cannot take keyboard focus from the off-screen copy", async () => {
    let focusedHiddenLink = true;
    await exportPng(
      { title: "T", slides: [slide("a", "Links", HOSTILE)], size: SIZE },
      {
        save: () => {
          const link = document.querySelector<HTMLElement>(".docwalk-export-capture a[href]")!;
          link.focus();
          focusedHiddenLink = document.activeElement === link;
        },
      },
    );
    expect(focusedHiddenLink).toBe(false);
  });

  test("the capture's fetch filter refuses foreign and empty image URLs, the second line behind the slide prep", async () => {
    // Empty matters: a blocked image has no src, and "" resolves to the page itself.
    for (const url of ["https://images.example/a.png", "//images.example/a.png", "", "  "]) {
      expect(await refuseForeignImages(url)).toMatch(/^data:image\//);
    }
    expect(await refuseForeignImages(`${location.origin}/logo.png`)).toBe(false);
    expect(await refuseForeignImages("/logo.png")).toBe(false);
  });
});

/** The Export menu's "Include marks" item, once the menu is open. */
const include = () => document.querySelector<HTMLElement>('[role="menuitemcheckbox"]')!;

describe("ExportMenu", () => {
  let root: Root | null = null;
  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    document.body.replaceChildren();
  });

  function render(
    getOptions: (withMarks: boolean, withNotes: boolean) => ExportOptions | null,
    hasMarks = false,
  ) {
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    act(() => root!.render(h(ExportMenu, { getOptions, hasMarks })));
    return container;
  }

  test("saved marks go into an export unless the viewer leaves them out, and the menu says which (decision 105)", async () => {
    const asked = vi.fn<(withMarks: boolean, withNotes: boolean) => ExportOptions | null>(
      () => null,
    );
    const trigger = render(asked, true).querySelector<HTMLElement>(".docwalk-export-trigger")!;
    await userEvent.click(trigger);
    expect(include().textContent).toBe("Include marks");
    expect(include().getAttribute("aria-checked")).toBe("true");
    await userEvent.click(document.querySelector<HTMLElement>('[role="menuitem"]')!);
    expect(asked).toHaveBeenLastCalledWith(true, false);

    // The menu stays open on the toggle, so the export comes next from the same menu.
    await userEvent.click(trigger);
    await userEvent.click(include());
    expect(include().getAttribute("aria-checked")).toBe("false");
    await userEvent.click(document.querySelector<HTMLElement>('[role="menuitem"]')!);
    expect(asked).toHaveBeenLastCalledWith(false, false);
    // It stays off for the next export, until the viewer turns it back on.
    await userEvent.click(trigger);
    expect(include().getAttribute("aria-checked")).toBe("false");
  });

  test("without saved marks the menu offers no marks option and asks for none", async () => {
    const asked = vi.fn<(withMarks: boolean, withNotes: boolean) => ExportOptions | null>(
      () => null,
    );
    await userEvent.click(render(asked).querySelector<HTMLElement>(".docwalk-export-trigger")!);
    expect(document.querySelector('[role="menuitemcheckbox"]')).toBeNull();
    await userEvent.click(document.querySelector<HTMLElement>('[role="menuitem"]')!);
    expect(asked).toHaveBeenLastCalledWith(false, false);
  });

  test("the trigger is a named 44px button and the menu offers the three exports by name", async () => {
    const el = render(() => null);
    const trigger = el.querySelector<HTMLElement>(".docwalk-export-trigger")!;
    expect(trigger.textContent).toBe("Export");
    expect(trigger.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
    await userEvent.click(trigger);
    const items = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    expect(items.map((i) => i.textContent)).toEqual([
      "Print or save as PDF",
      "Download HTML",
      "Download PNG images",
    ]);
    for (const item of items)
      expect(item.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
  });

  test("the menu works from the keyboard, and an empty deck is reported instead of exporting nothing", async () => {
    const el = render(() => null);
    act(() => el.querySelector<HTMLElement>(".docwalk-export-trigger")!.focus());
    await userEvent.keyboard("{Enter}");
    expect(document.activeElement?.getAttribute("role")).toBe("menuitem");
    await userEvent.keyboard("{ArrowDown}{Enter}");
    await vi.waitFor(() =>
      expect(el.querySelector('[role="status"]')?.textContent).toBe(
        "Nothing to export yet: the deck has no slides.",
      ),
    );
  });

  test("a failure while collecting the slides is announced, not lost as an unhandled rejection", async () => {
    const el = render(() => {
      throw new Error("the deck changed while exporting");
    });
    await userEvent.click(el.querySelector<HTMLElement>(".docwalk-export-trigger")!);
    await userEvent.click(document.querySelector<HTMLElement>('[role="menuitem"]')!);
    await vi.waitFor(() =>
      expect(el.querySelector('[role="status"]')?.textContent).toBe(
        "Export failed: the deck changed while exporting",
      ),
    );
    expect(el.querySelector(".docwalk-export-trigger")?.hasAttribute("data-pending")).toBe(false);
  });
});

describe("saved marks in exports (decision 105)", () => {
  // A review's marks are its outcome: the PDF, the HTML file and the PNGs
  // carry them over the slide they were drawn on.
  /** A pen line in the upper half and an arrow across the middle, on the 4096 grid. */
  const MARKS: SavedStroke[] = [
    { tool: "pen", color: "primary", points: [320, 1024, 1024, 1024, 2048, 1100] },
    { tool: "arrow", color: "primary", points: [320, 2048, 3776, 2048] },
  ];
  const marked = (s: ExportSlide): ExportSlide => ({ ...s, marks: MARKS });

  test("the HTML file draws each slide's marks over its page, as SVG built from their numbers", async () => {
    const { doc, text } = await parseExport(
      deck(marked(slide("a", "Marked")), slide("b", "Plain")),
    );
    const [first, second] = [...doc.querySelectorAll(".docwalk-export-page")];
    const overlay = first!.querySelector("svg.docwalk-export-marks")!;
    expect(overlay.getAttribute("viewBox")).toBe("0 0 1280 720");
    const pen = overlay.querySelector('path[data-tool="pen"][data-color="primary"]');
    expect(pen?.getAttribute("d")).toMatch(/^M [\d.]+ [\d.]+ Q/);
    const line = overlay.querySelector('g[data-tool="arrow"] line')!;
    // 320 and 3776 of 4096 across 1280 slide px, 2048 of 4096 down 720.
    expect(["x1", "y1", "x2", "y2"].map((a) => Number(line.getAttribute(a)))).toEqual([
      100, 360, 1180, 360,
    ]);
    expect(second!.querySelector(".docwalk-export-marks")).toBeNull();
    // The file colours the marks with the slide's own tokens; nothing else would.
    expect(text).toContain(".docwalk-export-marks");
  });

  test("a saved stroke shows in the PNG in its colour, where it was drawn", async () => {
    const files = await exportPng(
      { title: "T", slides: [marked(slide("a", "Marked")), slide("b", "Plain")], size: SIZE },
      { save: () => undefined },
    );
    // The arrow runs along y = 360 slide px; the image is at 2x.
    const [onMark, plain] = await Promise.all(files.map((f) => pixel(f.blob, 1280, 720)));
    expect(near(onMark!, token("--dw-color-primary"))).toBe(true);
    expect(near(plain!, token("--dw-color-slide"))).toBe(true);
  });

  test("the print view draws them over the page it prints", async () => {
    let box = { width: 0, height: 0 };
    await printDeck(deck(marked(slide("a", "Marked"))), (win) => {
      const overlay = win.document.querySelector(".docwalk-export-page .docwalk-export-marks")!;
      box = overlay.getBoundingClientRect();
      win.dispatchEvent(new Event("afterprint"));
    });
    expect({ width: box.width, height: box.height }).toEqual({ width: 1280, height: 720 });
  });
});

const withNotes = (s: ExportSlide, ...notes: string[]): ExportSlide => ({ ...s, notes });
const SHAPE = (main: Element) =>
  [...main.children].map((c) => (c.classList.contains("docwalk-export-notes") ? "notes" : "page"));

describe("speaker notes in a printed handout (decision 114)", () => {
  afterEach(() => document.querySelectorAll("iframe").forEach((f) => f.remove()));

  test("a print with notes puts each section's notes after its last page, as text", async () => {
    // Section one is split in two pages and prints its notes once, after the second.
    const options = deck(
      slide("a", "One"),
      withNotes(slide("a", "One, continued"), "Open with the <b>ledger</b> story <img src=x>"),
      withNotes(slide("b", "Two"), "Ask about the cutover.\nSecond line.", "A second comment."),
    );
    let seen: {
      shape: string[];
      markup: number;
      text: string;
      heading: string;
      label: string | null;
      paragraphs: string[];
    } | null = null;
    await printDeck(options, (win) => {
      const main = win.document.querySelector("main")!;
      const blocks = [...main.querySelectorAll<HTMLElement>(".docwalk-export-notes")];
      seen = {
        shape: SHAPE(main),
        markup: blocks[0]!.querySelectorAll("b, img").length,
        text: blocks[0]!.textContent ?? "",
        heading: blocks[1]!.querySelector("h2")?.textContent ?? "",
        label: blocks[1]!.getAttribute("aria-label"),
        paragraphs: [...blocks[1]!.querySelectorAll("p")].map((p) => p.textContent ?? ""),
      };
      win.dispatchEvent(new Event("afterprint"));
    });
    expect(seen).toEqual({
      shape: ["page", "page", "notes", "page", "notes"],
      markup: 0,
      text: expect.stringContaining("Open with the <b>ledger</b> story <img src=x>"),
      heading: "Two",
      label: "Speaker notes: Two",
      // One paragraph per comment; the line break stays in the text.
      paragraphs: ["Ask about the cutover.\nSecond line.", "A second comment."],
    });
  });

  test("a notes page starts on a new printed page, and so does the slide after it, and nothing is drawn over it", async () => {
    const marks: SavedStroke[] = [
      { tool: "arrow", color: "primary", points: [320, 2048, 3776, 2048] },
    ];
    const options = deck({ ...withNotes(slide("a", "One"), "Note one"), marks }, slide("b", "Two"));
    let seen: { breaks: string[]; overlays: number; notesMarks: number; white: string } | null =
      null;
    await printDeck(options, (win) => {
      const main = win.document.querySelector("main")!;
      const notes = main.querySelector<HTMLElement>(".docwalk-export-notes")!;
      seen = {
        breaks: [...main.children].map((c) => win.getComputedStyle(c).breakBefore),
        overlays: main.querySelectorAll(".docwalk-export-page .docwalk-export-marks").length,
        notesMarks: notes.querySelectorAll("svg").length,
        white: win.getComputedStyle(notes.querySelector("p")!).whiteSpace,
      };
      win.dispatchEvent(new Event("afterprint"));
    });
    expect(seen).toEqual({
      // Page, notes and the page after the notes each begin a printed page.
      breaks: ["auto", "page", "page"],
      overlays: 1,
      notesMarks: 0,
      white: "pre-wrap",
    });
  });

  test("a long note runs onto more printed pages and is not clipped", async () => {
    // Rule 3: the block grows with its text; print breaks it across pages.
    const words = Array.from({ length: 3000 }, (_, i) => `word${i}`);
    const long = words.join(" ");
    let seen: {
      overflow: string;
      grows: boolean;
      clipped: boolean;
      complete: boolean;
      wide: string;
    } | null = null;
    await printDeck(deck(withNotes(slide("a", "One"), long)), (win) => {
      const block = win.document.querySelector<HTMLElement>(".docwalk-export-notes")!;
      seen = {
        overflow: win.getComputedStyle(block).overflow,
        grows: block.getBoundingClientRect().height > 2 * 720,
        clipped: block.scrollHeight !== block.clientHeight,
        complete: block.textContent?.includes(words.at(-1)!) === true,
        wide: `${block.offsetWidth}`,
      };
      win.dispatchEvent(new Event("afterprint"));
    });
    expect(seen).toEqual({
      overflow: "visible",
      grows: true,
      clipped: false,
      complete: true,
      wide: "1280",
    });
  });

  test("a plain print carries no notes when the options carry none", async () => {
    let blocks = -1;
    await printDeck(deck(slide("a", "One"), slide("b", "Two")), (win) => {
      blocks = win.document.querySelectorAll(".docwalk-export-notes").length;
      win.dispatchEvent(new Event("afterprint"));
    });
    expect(blocks).toBe(0);
  });

  test("a slide whose notes list is empty gets no notes page", async () => {
    let shape: string[] = [];
    await printDeck(deck(withNotes(slide("a", "One")), slide("b", "Two")), (win) => {
      shape = SHAPE(win.document.querySelector("main")!);
      win.dispatchEvent(new Event("afterprint"));
    });
    expect(shape).toEqual(["page", "page"]);
  });

  test("the HTML file never carries notes, even from options that hold them", async () => {
    // People forward the HTML file: the exporter drops notes itself, whatever the menu asks.
    const { doc, text } = await parseExport(
      deck(withNotes(slide("a", "One"), "Private remark about pricing"), slide("b", "Two")),
    );
    expect(doc.querySelector(".docwalk-export-notes")).toBeNull();
    expect(text).not.toContain("Private remark about pricing");
    expect(doc.querySelectorAll(".docwalk-export-page")).toHaveLength(2);
  });
});

/** One RGBA pixel of a PNG. */
async function pixel(blob: Blob, x: number, y: number): Promise<number[]> {
  const bitmap = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(bitmap, 0, 0);
  return [...ctx.getImageData(x, y, 1, 1).data];
}

/** A design token's colour as RGBA, the way a canvas paints it. */
function token(name: string): number[] {
  const ctx = new OffscreenCanvas(1, 1).getContext("2d")!;
  ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  ctx.fillRect(0, 0, 1, 1);
  return [...ctx.getImageData(0, 0, 1, 1).data];
}

const near = (a: number[], b: number[]) => a.every((n, i) => Math.abs(n - (b[i] ?? 0)) <= 8);
