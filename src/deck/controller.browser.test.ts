import { afterEach, describe, expect, test } from "vitest";
import { clonePages, createDeckController } from "./controller";

afterEach(() => {
  document.body.replaceChildren();
});

/** A stage shaped like the deck's `.slides`: paginated sections plus a sibling overlay. */
function stageWith(pages: { id: string; page: number; text: string }[]) {
  const stage = document.createElement("div");
  stage.className = "slides";
  const sections = pages.map(({ id, page, text }) => {
    const section = document.createElement("section");
    section.dataset["docwalkId"] = id;
    section.dataset["page"] = String(page);
    section.dataset["title"] = id;
    section.innerHTML = `<div class="docwalk-slide"><p>${text}</p></div>`;
    return section;
  });
  // The pen layer lives in the stage too; it is not a slide.
  const overlay = document.createElement("div");
  overlay.className = "docwalk-annotate";
  stage.append(...sections, overlay);
  document.body.append(stage);
  return { stage, sections };
}

const reveal = {
  getIndices: () => ({ h: 0 }),
  slide() {},
  next() {},
  prev() {},
  on() {},
  off() {},
};

describe("clonePages: what the exporters receive", () => {
  test("every slide arrives once, in deck order, with its own address", () => {
    const { stage, sections } = stageWith([
      { id: "intro", page: 1, text: "A" },
      { id: "design", page: 1, text: "B" },
      { id: "design", page: 2, text: "C" },
    ]);
    const pages = clonePages(createDeckController(reveal, sections, stage));
    expect(pages.map((p) => p.info.address)).toEqual(["intro/1", "design/1", "design/2"]);
    expect(pages.map((p) => p.element.textContent)).toEqual(["A", "B", "C"]);
  });

  test("the exporters mutate copies, never the live deck the audience is watching", () => {
    // printDeck and exportPng strip reveal's styles and blocked images from what they get.
    const { stage, sections } = stageWith([{ id: "intro", page: 1, text: "Live" }]);
    const [page] = clonePages(createDeckController(reveal, sections, stage));
    expect(page?.element).not.toBe(sections[0]);
    page?.element.replaceChildren();
    expect(sections[0]?.textContent).toBe("Live");
  });

  test("a slide whose page left the stage fails loudly instead of vanishing from the export", () => {
    const { stage, sections } = stageWith([
      { id: "intro", page: 1, text: "A" },
      { id: "gone", page: 1, text: "B" },
    ]);
    const controller = createDeckController(reveal, sections, stage);
    sections[1]?.remove();
    expect(() => clonePages(controller)).toThrow(/gone\/1/);
  });
});
