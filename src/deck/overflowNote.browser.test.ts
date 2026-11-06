import { afterEach, describe, expect, test } from "vitest";
import fixture from "../../fixtures/ledger-redesign.md?raw";
import { parseMarkdown, sectionize } from "../sectioning/sectionize";
// Same fonts as the app, so measurements and pagination match what users see.
import "@fontsource-variable/bricolage-grotesque";
import "@fontsource-variable/inter";
import "@fontsource-variable/jetbrains-mono";
import "virtual:docwalk-tokens.css";
import "../styles.css";
import { fitDiagrams, measureOffscreen, settled, slideBodySize } from "./measure";
import { renderDiagrams } from "./mermaid";
import { paginateSlide } from "./paginate";
import { describeOverflow, flagPages } from "./pages";
import { buildSlides } from "./slides";

/**
 * AGENTS.md rule 3: overflow is reported or split, never hidden. The slide's
 * note sits under the slide body and takes its height from the body once it
 * shows, so a note measured as hidden can itself push content out of sight.
 * And a code block scrolls inside itself, so its overflow never reaches the
 * body: it has to be measured on its own, as diagram hosts are (rule 4).
 */

const SIZE = { width: 1280, height: 720 };

afterEach(() => {
  document.body.replaceChildren();
});

const bodyOf = (page: HTMLElement) => page.querySelector(".docwalk-slide-body") as HTMLElement;
const noteOf = (page: HTMLElement) => page.querySelector<HTMLElement>(".docwalk-overflow")!;

/** Build, render, fit and paginate every slide of `markdown`, then flag the pages, as Deck does. */
async function deckPages(markdown: string): Promise<HTMLElement[]> {
  const slides = buildSlides(sectionize(parseMarkdown(markdown)));
  const container = document.createElement("div");
  container.append(...slides);
  document.body.append(container);
  await renderDiagrams(container);
  fitDiagrams(container, slideBodySize(SIZE));
  await settled(container);
  const pages = slides.flatMap((s) => paginateSlide(s, { size: SIZE }));
  container.replaceChildren(...pages);
  flagPages(pages, SIZE);
  return pages;
}

// Twenty nodes in a row: fitted to the slide's width, the diagram ends up
// well below the readable scale, so its slide always carries the note.
const WIDE_DIAGRAM = [
  "```mermaid",
  "flowchart LR",
  Array.from({ length: 20 }, (_, i) => `  n${i}[Step ${i}]`).join("\n"),
  Array.from({ length: 19 }, (_, i) => `  n${i} --> n${i + 1}`).join("\n"),
  "```",
].join("\n");

/** What is wrong with each page as the audience sees it, note shown. */
function problemsOf(pages: HTMLElement[]): string[] {
  const shown = measureOffscreen(pages.map(bodyOf), SIZE);
  return pages.flatMap((page, i) => {
    const m = shown[i]!;
    const note = noteOf(page);
    const where = `${page.dataset["docwalkId"]}/${page.dataset["page"] ?? 1}`;
    if (m.body.y > 0 && note.hidden) return [`${where}: ${m.body.y}px hidden, no note`];
    if (!note.hidden && note.textContent !== describeOverflow(m))
      return [`${where}: note says "${note.textContent}", page is "${describeOverflow(m)}"`];
    // Paragraphs can always move to the next page: a page with more than one
    // paragraph must be split, not merely flagged.
    const paragraphs = bodyOf(page).querySelectorAll(":scope > p").length;
    if (m.body.y > 0 && paragraphs > 1)
      return [`${where}: overflows by ${m.body.y}px with ${paragraphs} paragraphs`];
    return [];
  });
}

describe("the diagnostic note takes room on the slide", () => {
  test("no page hides content behind its own note, and the note describes the page as shown", async () => {
    // A lead paragraph growing by about a line at a time moves where the page
    // break falls, so across the sweep the room left under the last paragraph
    // takes many values; some are less than the note's height. There, a note
    // measured as hidden used to push the last line out of view with no
    // "Does not fit" in it.
    const rest = Array.from({ length: 14 }, (_, i) => `Paragraph ${i}, one line.`).join("\n\n");
    const sections = Array.from(
      { length: 11 },
      (_, n) => `## Fill ${n}\n\n${WIDE_DIAGRAM}\n\nLead ${"word ".repeat(1 + n * 14)}\n\n${rest}`,
    );
    const pages = await deckPages(`${sections.join("\n\n")}\n`);
    expect(problemsOf(pages)).toEqual([]);
    // The sweep did exercise the note: every slide's first page has the too-small diagram.
    expect(pages.filter((p) => !noteOf(p).hidden).length).toBeGreaterThanOrEqual(11);
  }, 60_000);

  test("the acceptance fixture: every page fits with its note, or its note says by how much", async () => {
    // The review found #proposed-architecture/1 hiding 35 px and an
    // overflowing page reporting 93 px of a real 140 px.
    const pages = await deckPages(fixture);
    expect(problemsOf(pages)).toEqual([]);
  }, 60_000);
});

describe("code wider than the slide", () => {
  test("a code line past the slide's edge is reported, not clipped inside the block", async () => {
    // A log line or URL of 300 characters: the slide's <pre> scrolls sideways,
    // so the right half is out of sight while the body itself fits.
    const long = `GET /v1/ledger/entries?account=${"0123456789abcdef".repeat(17)} 200`;
    const [page] = await deckPages(`## Request log\n\n\`\`\`\n${long}\n\`\`\`\n`);
    const [m] = measureOffscreen([bodyOf(page!)], SIZE);
    expect(m!.body.x).toBe(0); // the body alone would pass this slide
    expect(m!.code[0]!.x).toBeGreaterThan(500);
    expect(m!.overflows).toBe(true);
    const note = noteOf(page!);
    expect(note.hidden).toBe(false);
    expect(note.textContent).toContain("1 code block too wide");
  });

  test("a code block that fits raises no note", async () => {
    const [page] = await deckPages("## Request\n\n```\nGET /v1/health 200\n```\n");
    expect(noteOf(page!).hidden).toBe(true);
  });
});
