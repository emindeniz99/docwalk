import { afterEach, describe, expect, test } from "vitest";
import fixture from "../../fixtures/ledger-redesign.md?raw";
// Same fonts and styles as the app, so pagination measures what users see.
import "@fontsource-variable/bricolage-grotesque";
import "@fontsource-variable/inter";
import "@fontsource-variable/jetbrains-mono";
import "virtual:docwalk-tokens.css";
import "../styles.css";
import { paginateSlide } from "../deck/paginate";
import { purifyHtml } from "../deck/purify";
import { buildSlide, buildSlides } from "../deck/slides";
import { slideText } from "../deck/slideText";
import { parseMarkdown, sectionize } from "../sectioning/sectionize";
import { nodesToHtml } from "./toHtml";

/**
 * GFM task list items (decision 86). Both sanitizers remove `<input>`, so the
 * box and its state used to vanish. The state now comes from the Markdown
 * tree and is drawn as a read-only mark that is not a form control; an
 * `<input>` in the author's own HTML is still removed.
 */

const SIZE = { width: 1280, height: 720 };
const DONE = "Task done";
const OPEN = "Task not done";

afterEach(() => {
  document.body.replaceChildren();
});

function render(markdown: string): HTMLElement {
  const host = document.createElement("div");
  host.append(purifyHtml(nodesToHtml(parseMarkdown(markdown).children)));
  document.body.append(host);
  return host;
}

/** The accessible name of each task mark, in document order. */
const marks = (host: ParentNode) =>
  [...host.querySelectorAll(".docwalk-task-box")].map((el) => el.getAttribute("aria-label"));

describe("task list marks", () => {
  test("checked and open items keep their state as named, read-only images", () => {
    const host = render("- [x] Agree on the schema\n- [ ] Load-test the relay\n- plain item\n");
    expect(marks(host)).toEqual([DONE, OPEN]);
    for (const box of host.querySelectorAll(".docwalk-task-box")) {
      expect(box.getAttribute("role")).toBe("img");
      expect(box.children.length).toBe(0);
    }
    // The mark stands where the checkbox stood, so the item text follows it.
    const [first, second] = host.querySelectorAll("li");
    expect(first?.firstElementChild?.classList.contains("docwalk-task-box")).toBe(true);
    expect(second?.firstElementChild?.classList.contains("docwalk-task-box")).toBe(true);
    expect(host.querySelectorAll("li:not(.task-list-item) .docwalk-task-box")).toHaveLength(0);
  });

  test("no form control reaches the page: the mark is not an input", () => {
    const host = render("- [x] done\n- [ ] open\n");
    expect(host.querySelectorAll("input, button, select, textarea, form")).toHaveLength(0);
    expect(host.querySelectorAll("[tabindex], [contenteditable]")).toHaveLength(0);
  });

  test("an input in the author's HTML is still removed while the Markdown task keeps its mark", () => {
    const host = render(
      [
        '<input type="checkbox" checked disabled> sneaky',
        "",
        '<form action="https://attacker.invalid/"><input name="x" value="y"><button>go</button></form>',
        "",
        '<ul><li><input type="checkbox" checked disabled> raw item</li></ul>',
        "",
        "- [x] real task",
        "- [ ] open task",
      ].join("\n"),
    );
    expect(host.querySelectorAll("input, form, button")).toHaveLength(0);
    // Only the two Markdown tasks are drawn; nothing the author wrote becomes a mark.
    expect(marks(host)).toEqual([DONE, OPEN]);
    expect(host.textContent).toContain("sneaky");
    expect(host.textContent).toContain("raw item");
  });

  test("markup that imitates a mark is not one: the state is not the author's to forge", () => {
    const host = render(
      [
        '<ul><li class="task-list-item"><span data-docwalk-task="checked">forged one</span></li></ul>',
        "",
        '<ul><li class="task-list-item" data-docwalk-task="checked">forged two</li></ul>',
        "",
        '<span class="docwalk-task-box" role="img" aria-label="Task done">forged three</span>',
        "",
        '<ul class="contains-task-list"><li class="task-list-item"><span data-docwalk-task="x:checked">forged four</span></li></ul>',
      ].join("\n"),
    );
    expect(marks(host)).toEqual([]);
    expect(host.querySelectorAll("[data-docwalk-task]")).toHaveLength(0);
    expect(host.querySelectorAll("[role=img]")).toHaveLength(0);
    for (const word of ["one", "two", "three", "four"]) expect(host.textContent).toContain(word);
  });

  test("loose, nested and ordered lists keep every mark, and the item text is unchanged", () => {
    const host = render(
      [
        "1. [x] ordered done",
        "2. [ ] ordered open",
        "",
        "- [x] loose done",
        "",
        "- [ ] loose open",
        "  - [x] nested done",
        "  - [ ] nested open",
        "",
        "- [X] capital X",
        "- [ ] with `code` and [a link](https://example.com/)",
      ].join("\n"),
    );
    expect(marks(host)).toEqual([DONE, OPEN, DONE, OPEN, DONE, OPEN, DONE, OPEN]);
    const texts = [...host.querySelectorAll("li.task-list-item")].map((li) =>
      // Direct text of the item, not of its nested list.
      [...li.childNodes]
        .concat([...li.querySelectorAll(":scope > p")].flatMap((p) => [...p.childNodes]))
        .filter((n) => !(n instanceof HTMLElement && n.matches("ul, ol, p")))
        .map((n) => n.textContent)
        .join("")
        .trim(),
    );
    expect(texts).toContain("ordered done");
    expect(texts).toContain("loose open");
    expect(texts).toContain("with code and a link");
    expect(host.textContent).not.toContain(DONE);
    expect(host.textContent).not.toContain(OPEN);
  });

  test("every task in the sample document keeps a mark with the state it was written with", () => {
    const written = [...fixture.matchAll(/^\s*[-*] \[([ xX])\] /gm)].map((m) =>
      m[1] === " " ? OPEN : DONE,
    );
    expect(written.length).toBeGreaterThan(9);
    expect(marks(render(fixture))).toEqual(written);
  });

  test("a task item in a footnote-free quote and a table-free list does not disturb its neighbours", () => {
    const host = render("> - [x] quoted task\n\n- [ ] after the quote\n");
    expect(marks(host)).toEqual([DONE, OPEN]);
  });
});

describe("task lists on slides", () => {
  const listOf = (n: number) =>
    Array.from({ length: n }, (_, i) => `- [${i % 3 === 0 ? "x" : " "}] Task number ${i + 1}`).join(
      "\n",
    );

  test("a task list longer than a page splits between items and loses no item or state", () => {
    const n = 60;
    const section = sectionize(parseMarkdown(`## Plan\n\n${listOf(n)}\n`)).sections[0];
    const pages = paginateSlide(buildSlide(section as never), { size: SIZE });
    expect(pages.length).toBeGreaterThan(1);
    const rows = pages.flatMap((p) =>
      [...p.querySelectorAll("li.task-list-item")].map((li) => ({
        text: li.textContent?.trim(),
        mark: li.querySelector(".docwalk-task-box")?.getAttribute("aria-label"),
      })),
    );
    expect(rows).toEqual(
      Array.from({ length: n }, (_, i) => ({
        text: `Task number ${i + 1}`,
        mark: i % 3 === 0 ? DONE : OPEN,
      })),
    );
  });

  test("slide text for the palette search holds the task words and none of the mark's name", () => {
    const [page] = buildSlides(
      sectionize(parseMarkdown("## Plan\n\n- [x] Agree on the schema\n- [ ] Ship it\n")),
    );
    const text = slideText(page as HTMLElement);
    expect(text).toContain("Agree on the schema Ship it");
    expect(text).not.toContain("Task");
  });
});
