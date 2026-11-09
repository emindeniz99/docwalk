import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nProvider } from "react-aria-components";
import { afterEach, describe, expect, test, vi } from "vitest";
import { userEvent } from "vitest/browser";
import "virtual:docwalk-tokens.css";
import "../styles.css";
import type { SlideInfo } from "../deck/controller";
import { CommandPalette, type Command } from "./CommandPalette";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.replaceChildren();
});

const slide = (
  index: number,
  sectionId: string,
  page: number,
  title: string,
  text: string,
): SlideInfo => ({
  index,
  address: `${sectionId}/${page}`,
  sectionId,
  page,
  title,
  flagged: false,
  note: null,
  text,
});

const SLIDES = [
  slide(0, "intro", 1, "Introduction", "Why we rebuild the ledger."),
  slide(1, "failure", 1, "Failure handling", "Every failure has an owner and a budget."),
  slide(
    2,
    "failure",
    2,
    "Failure handling",
    "The adapter retries on its own, and so does the API.",
  ),
  slide(3, "rollout", 1, "Rollout", "Shadow traffic first. Then cut over."),
];

function render(opts: {
  slides?: SlideInfo[];
  commands?: Command[];
  onGoTo?: (address: string) => void;
  locale?: string;
}) {
  root = createRoot(document.body.appendChild(document.createElement("div")));
  act(() =>
    root!.render(
      h(I18nProvider, {
        locale: opts.locale ?? "en-US",
        children: h(CommandPalette, {
          isOpen: true,
          onOpenChange: () => undefined,
          slides: opts.slides ?? SLIDES,
          commands: opts.commands ?? [],
          onGoTo: opts.onGoTo ?? (() => undefined),
        }),
      }),
    ),
  );
}

const search = async (query: string) => {
  const box = document.querySelector<HTMLInputElement>('input[type="text"], input')!;
  await userEvent.fill(box, query);
};
// React Aria wraps the "No match" text in a menuitem of its own; it is not a result.
const items = () =>
  [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].filter(
    (e) => !e.querySelector(".docwalk-palette-empty"),
  );
const sectionNames = () =>
  [...document.querySelectorAll(".docwalk-palette-section header")].map((e) => e.textContent);

describe("palette: slide text next to titles (decision 81)", () => {
  test("a word that is only in a slide's text lists that slide, under its own heading, with a snippet", async () => {
    render({});
    await search("retries");
    await expect.poll(() => items().length).toBe(1);
    expect(sectionNames()).toEqual(["In slide text"]);
    const item = items()[0]!;
    expect(item.querySelector("mark")?.textContent).toBe("retries");
    expect(item.textContent).toContain("Failure handling");
    expect(item.textContent).toContain("The adapter retries on its own");
  });

  test("a title match stays in Slides, as before, with no snippet", async () => {
    render({});
    await search("rollout");
    await expect.poll(() => items().length).toBe(1);
    expect(sectionNames()).toEqual(["Slides"]);
    expect(items()[0]?.querySelector("mark")).toBeNull();
  });

  test("a slide whose title matches is not listed a second time for its text", async () => {
    render({});
    await search("failure");
    // Both pages of "Failure handling" match by title; page 1's text also says "failure".
    await expect.poll(() => items().length).toBe(2);
    expect(sectionNames()).toEqual(["Slides"]);
  });

  test("choosing a hit goes to the page that holds the words, not the section's first page", async () => {
    const onGoTo = vi.fn<(address: string) => void>();
    render({ onGoTo });
    await search("retries");
    await expect.poll(() => items().length).toBe(1);
    await userEvent.click(items()[0]!);
    expect(onGoTo).toHaveBeenCalledWith("failure/2");
  });

  test("the keyboard reaches a text hit: type, then Enter on the first result", async () => {
    const onGoTo = vi.fn<(address: string) => void>();
    render({ onGoTo });
    await search("shadow traffic");
    await expect.poll(() => items().length).toBe(1);
    await userEvent.keyboard("{Enter}");
    expect(onGoTo).toHaveBeenCalledWith("rollout/1");
  });

  test("a text hit has the slide's name and number in its accessible name, like a title result", async () => {
    render({});
    await search("retries");
    await expect.poll(() => items().length).toBe(1);
    const name = items()[0]!.textContent ?? "";
    expect(name).toContain("Failure handling");
    expect(name).toContain("3");
  });

  test("an empty query lists every slide and no text section, as before", () => {
    render({});
    expect(items()).toHaveLength(SLIDES.length);
    expect(sectionNames()).not.toContain("In slide text");
  });

  test("a query nothing matches says so", async () => {
    render({});
    await search("zzzzzz");
    await expect
      .poll(() => document.querySelector(".docwalk-palette-empty")?.textContent)
      .toBe("No match");
    expect(items()).toHaveLength(0);
  });

  test("a command still matches by its label", async () => {
    const run = vi.fn<() => void>();
    render({ commands: [{ id: "overview", label: "Slide overview", run }] });
    await search("overview");
    await expect.poll(() => items().length).toBe(1);
    await userEvent.click(items()[0]!);
    expect(run).toHaveBeenCalled();
  });
});

describe("palette: limits and hostile text", () => {
  test("at most ten text hits show, and a line says how many more there are", async () => {
    const many = Array.from({ length: 14 }, (_, i) =>
      slide(i, `s${i}`, 1, `Slide ${i}`, "the retries budget"),
    );
    render({ slides: many });
    await search("retries");
    await expect.poll(() => items().length).toBe(10);
    expect(document.querySelector(".docwalk-palette-more")?.textContent).toContain("4");
  });

  test("page text that looks like markup is shown as characters and runs nothing", async () => {
    const hostile = slide(
      0,
      "bad",
      1,
      "Plain",
      'Try <img src=x onerror="window.paletteOwned = 1"> and </section><script>window.paletteOwned = 2</script> end',
    );
    render({ slides: [hostile] });
    await search("onerror");
    await expect.poll(() => items().length).toBe(1);
    const item = items()[0]!;
    expect(item.querySelector("img, script")).toBeNull();
    expect(item.textContent).toContain('<img src=x onerror="window.paletteOwned = 1">');
    expect(item.querySelector("mark")?.textContent).toBe("onerror");
    expect(document.querySelector(".docwalk-palette img")).toBeNull();
    expect((window as { paletteOwned?: number }).paletteOwned).toBeUndefined();
  });

  test("a hostile slide title is text too", async () => {
    const hostile = slide(0, "bad", 1, "<img src=x onerror=1>", "plain words");
    render({ slides: [hostile] });
    await search("plain words");
    await expect.poll(() => items().length).toBe(1);
    expect(document.querySelector(".docwalk-palette img")).toBeNull();
    expect(items()[0]?.textContent).toContain("<img src=x onerror=1>");
  });
});

describe("palette: Turkish locale", () => {
  test("in the Turkish UI, a capital I finds dotless ı in a slide's text", async () => {
    const tr = [slide(0, "a", 1, "Başlık", "Işık ve sıra burada")];
    render({ slides: tr, locale: "tr-TR" });
    await search("SIRA");
    await expect.poll(() => items().length).toBe(1);
    expect(items()[0]?.querySelector("mark")?.textContent).toBe("sıra");
  });
});
