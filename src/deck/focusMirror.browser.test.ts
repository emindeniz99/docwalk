import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, test } from "vitest";
import { userEvent } from "vitest/browser";
import "virtual:docwalk-tokens.css";
import "../styles.css";
import { MirrorStore } from "../annotate/mirrorStore";
import type { FocusEvent, MirrorOp } from "../annotate/mirrorTypes";
import { parseMarkdown, sectionize } from "../sectioning/sectionize";
import type { DeckController } from "./controller";
import { Deck } from "./Deck";
import { openBlockFocus } from "./focus";
import { observeFocus } from "./focusEvents";
import { followFocus } from "./focusMirror";

/**
 * The code, table and image focus views, mirrored (decision 106). The
 * presenter's view says which block it shows, by kind and place on the
 * slide, and how it is zoomed, scrolled and marked; a follower opens the
 * same view on its own copy of that block. Both run on one real deck here:
 * the presenter's side is a click, the follower's is a `MirrorStore` that
 * the room would fill.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  act(() => root?.unmount());
  root = null;
  document.body.replaceChildren();
});

const REMOTE = "https://images.invalid/chart.png";
const cell = (i: number) => `${"w".repeat(11)}${i % 10}`;
const row = (cells: string[]) => `| ${cells.join(" | ")} |`;
const head = Array.from({ length: 12 }, (_, i) => cell(i));

const DOC = [
  "## Code",
  "",
  "```ts",
  "const a = 1;",
  "const b = 2;",
  "```",
  "",
  "```ts",
  "function f() {",
  "  const c = 3;",
  "  return c;",
  "}",
  "```",
  "",
  "## Table",
  "",
  row(head),
  row(head.map(() => "---")),
  row(head),
  row(head),
  "",
  "## Images",
  "",
  `![Chart](${REMOTE})`,
  "",
  "![Company logo](/icons/icon-192.png)",
  "",
  "## Next",
  "",
  "More.",
  "",
].join("\n");

/** Six listings of ten lines each: too tall for one slide, so the section paginates (never inside a listing). */
const MANY = [
  "## Many",
  "",
  ...Array.from({ length: 6 }, (_k, k) => [
    "```text",
    ...Array.from({ length: 10 }, (_i, i) => `listing ${"ABCDEF"[k]} line ${i + 1}`),
    "```",
    "",
  ]).flat(),
  "## After",
  "",
  "Text.",
  "",
].join("\n");

async function mountDeck(markdown = DOC) {
  const container = document.createElement("div");
  Object.assign(container.style, { display: "grid", width: "1280px", height: "800px" });
  document.body.append(container);
  root = createRoot(container);
  const readies: DeckController[] = [];
  const onReady = (c: DeckController | null) => {
    if (c) readies.push(c);
  };
  act(() => root!.render(h(Deck, { plan: sectionize(parseMarkdown(markdown), "auto"), onReady })));
  await expect.poll(() => readies.length, { timeout: 20_000, interval: 10 }).toBeGreaterThan(0);
  const controller = readies.at(-1)!;
  const address = (title: string) => controller.slides().find((s) => s.title === title)!.address;
  return { container, controller, address };
}

/** A follower's side: a store the room fills, followed by the deck. */
function follow(controller: DeckController) {
  const store = new MirrorStore();
  cleanups.push(followFocus(controller, store));
  const send = (...ops: MirrorOp[]) => {
    for (const op of ops) store.apply(op);
  };
  return { store, send };
}

const view = () => document.querySelector<HTMLElement>(".docwalk-focus");
const stage = () => view()!.querySelector<HTMLElement>(".docwalk-focus-stage")!;
const scaleOf = () =>
  Number(
    view()!
      .querySelector<HTMLElement>(".docwalk-focus-sheet")!
      .style.getPropertyValue("--focus-scale"),
  );
const lines = () => [
  ...document.querySelectorAll<HTMLElement>(".docwalk-focus .docwalk-code-line"),
];
const pressed = () =>
  lines().flatMap((line, i) => (line.getAttribute("aria-pressed") === "true" ? [i + 1] : []));
const present = (container: HTMLElement) =>
  container.querySelector<HTMLElement>(".reveal .slides section.present")!;
const remoteRequests = () =>
  performance
    .getEntriesByType("resource")
    .filter((e) => e.name.startsWith("https://images.invalid/"));

function listen() {
  const events: FocusEvent[] = [];
  cleanups.push(observeFocus((event) => events.push(event)));
  return events;
}

describe("what the presenter's view tells the mirror (decision 106)", () => {
  test("opening a block names its kind and its place among the blocks of that kind, a blocked image included", async () => {
    // The follower may not have loaded the first image; it must still number the second one 2.
    const { container, controller, address } = await mountDeck();
    const events = listen();
    controller.goTo(address("Images"));
    const logo = present(container).querySelectorAll<HTMLImageElement>("img")[1]!;
    expect(
      present(container).querySelector("img")!.classList.contains("docwalk-blocked-image"),
    ).toBe(true);
    await userEvent.click(logo);
    expect(events[0]).toEqual({ kind: "open", slide: address("Images"), block: "image", n: 2 });
    await userEvent.keyboard("{Escape}");
    expect(events.at(-1)).toEqual({ kind: "close" });

    controller.goTo(address("Code"));
    await userEvent.click(present(container).querySelectorAll<HTMLElement>("pre")[1]!);
    expect(events.find((e, i) => i > 1 && e.kind === "open")).toEqual({
      kind: "open",
      slide: address("Code"),
      block: "code",
      n: 2,
    });
  });

  test("a code view reports its Fit as it opens, then zoom as a share of that Fit, and each change of marks", async () => {
    const { container, controller, address } = await mountDeck();
    const events = listen();
    controller.goTo(address("Code"));
    await userEvent.click(present(container).querySelectorAll<HTMLElement>("pre")[1]!);
    // Open first, so the mirror knows what the view belongs to; then the view at Fit.
    expect(events.slice(0, 2)).toEqual([
      { kind: "open", slide: address("Code"), block: "code", n: 2 },
      { kind: "view", scale: 1, x: 0, y: 0 },
    ]);
    const fit = scaleOf();
    await userEvent.click(view()!.querySelector<HTMLElement>('[aria-label="Zoom in"]')!);
    const zoomed = events.filter((e) => e.kind === "view").at(-1);
    expect(zoomed).toMatchObject({ kind: "view" });
    expect(zoomed?.kind === "view" && zoomed.scale).toBeCloseTo((fit + 0.25) / fit, 5);

    await userEvent.click(lines()[0]!);
    await userEvent.click(lines()[2]!);
    await userEvent.click(lines()[0]!);
    await userEvent.click(
      view()!.querySelector<HTMLElement>('[aria-label="Clear all marked lines"]')!,
    );
    expect(events.filter((e) => e.kind === "lines")).toEqual([
      { kind: "lines", lines: [1] },
      { kind: "lines", lines: [1, 3] },
      { kind: "lines", lines: [3] },
      { kind: "lines", lines: [] },
    ]);
  });

  test("an image view closed before its first frame reports nothing after its close", async () => {
    // Fit waits for a frame. Run on a view that is gone, it measured an empty
    // stage and sent a pan of NaN, after the close and into the next view.
    const { container, controller, address } = await mountDeck();
    const events = listen();
    controller.goTo(address("Images"));
    const close = openBlockFocus(present(container).querySelectorAll<HTMLImageElement>("img")[1]!);
    close();
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    expect(events.map((e) => e.kind)).toEqual(["open", "close"]);
  });

  test("a table view reports how far it is scrolled, as a share of how far it can scroll", async () => {
    const { container, controller, address } = await mountDeck();
    const events = listen();
    controller.goTo(address("Table"));
    await userEvent.click(present(container).querySelector<HTMLElement>("table")!);
    const across = stage().scrollWidth - stage().clientWidth;
    expect(across).toBeGreaterThan(100);
    stage().scrollLeft = across / 2;
    await expect
      .poll(() => {
        const last = events.filter((e) => e.kind === "view").at(-1);
        return last?.kind === "view" ? last.x : -1;
      })
      .toBeCloseTo(0.5, 2);
  });
});

describe("a follower opens the presenter's view on its own copy (decision 106)", () => {
  test("code: the named block opens with the presenter's marks and zoom, and closes with the presenter", async () => {
    const { controller, address } = await mountDeck();
    const { send } = follow(controller);
    // Not on that slide yet: nothing opens until the follower gets there.
    controller.goTo(address("Next"));
    send(
      { op: "focus-open", slide: address("Code"), code: 2 },
      { op: "focus-lines", lines: [1, 3] },
    );
    expect(view()).toBeNull();
    controller.goTo(address("Code"));
    await expect.poll(() => view()?.dataset["kind"]).toBe("code");
    // The second listing, not the first.
    expect(lines()).toHaveLength(4);
    expect(lines()[0]!.textContent).toContain("function f()");
    expect(pressed()).toEqual([1, 3]);
    // Zoom is a share of each screen's own Fit.
    const fit = scaleOf();
    send({ op: "focus-view", scale: 1.5, x: 0, y: 0 });
    expect(scaleOf()).toBeCloseTo(Math.min(4, fit * 1.5), 5);
    send({ op: "focus-lines", lines: [2, 99] });
    expect(pressed()).toEqual([2]);
    send({ op: "focus-close" });
    expect(view()).toBeNull();
  });

  test("table: the scroll follows as a share of how far this screen can scroll", async () => {
    const { controller, address } = await mountDeck();
    const { send } = follow(controller);
    controller.goTo(address("Table"));
    send({ op: "focus-open", slide: address("Table"), table: 1 });
    expect(view()?.dataset["kind"]).toBe("table");
    const across = () => stage().scrollWidth - stage().clientWidth;
    expect(across()).toBeGreaterThan(100);
    send({ op: "focus-view", scale: 1, x: 1, y: 0 });
    expect(stage().scrollLeft).toBeCloseTo(across(), -1);
    send({ op: "focus-view", scale: 1, x: 0.5, y: 0 });
    expect(stage().scrollLeft).toBeCloseTo(across() / 2, -1);
    // A hostile pan far outside the range lands on the edge, not past it.
    send({ op: "focus-view", scale: 1, x: -8, y: 8 });
    expect(stage().scrollLeft).toBe(0);
  });

  test("image: a loaded image opens and zooms; one the follower blocked opens nothing and is never requested", async () => {
    const { container, controller, address } = await mountDeck();
    const { send } = follow(controller);
    controller.goTo(address("Images"));
    const [chart] = present(container).querySelectorAll<HTMLImageElement>("img");
    send({ op: "focus-open", slide: address("Images"), image: 1 });
    send({ op: "focus-view", scale: 3, x: 0.1, y: 0.1 });
    expect(view()).toBeNull();
    // The gate of decision 33 holds: still a placeholder, no address, no request.
    expect(chart!.classList.contains("docwalk-blocked-image")).toBe(true);
    expect(chart!.getAttribute("src")).toBeNull();
    await new Promise((r) => setTimeout(r, 100));
    expect(remoteRequests()).toEqual([]);

    send({ op: "focus-open", slide: address("Images"), image: 2 });
    expect(view()?.dataset["kind"]).toBe("image");
    expect(view()!.querySelector("img")!.alt).toBe("Company logo");
    send({ op: "focus-view", scale: 3, x: 0, y: 0 });
    await expect
      .poll(() => view()!.querySelector<HTMLElement>(".docwalk-focus-canvas")!.style.transform)
      .toContain("scale(3)");
    expect(remoteRequests()).toEqual([]);
  });

  test("a block the follower does not have opens nothing and throws nothing", async () => {
    // Another pagination, or a hostile presenter: the follower shows its slide and waits.
    const { controller, address } = await mountDeck();
    const { send } = follow(controller);
    controller.goTo(address("Code"));
    send({ op: "focus-open", slide: address("Code"), code: 3 });
    send({ op: "focus-lines", lines: [1] });
    send({ op: "focus-open", slide: address("Code"), table: 1 });
    send({ op: "focus-open", slide: address("Code"), image: 1000 });
    send({ op: "focus-open", slide: "nowhere/1", code: 1 });
    expect(view()).toBeNull();
    send({ op: "focus-open", slide: address("Code"), code: 1 });
    expect(view()?.dataset["kind"]).toBe("code");
  });

  test("Escape on the follower keeps the view shut until the presenter opens another; leaving the slide does not", async () => {
    const { controller, address } = await mountDeck();
    const { send } = follow(controller);
    controller.goTo(address("Code"));
    send({ op: "focus-open", slide: address("Code"), code: 1 });
    await userEvent.keyboard("{Escape}");
    expect(view()).toBeNull();
    send({ op: "focus-view", scale: 2, x: 0, y: 0 }, { op: "focus-lines", lines: [1] });
    expect(view()).toBeNull();
    send({ op: "focus-open", slide: address("Code"), code: 2 }, { op: "focus-lines", lines: [2] });
    expect(pressed()).toEqual([2]);

    // A change of slide closes the copy (decision 87) but is not the viewer's choice.
    controller.goTo(address("Next"));
    await expect.poll(view).toBeNull();
    controller.goTo(address("Code"));
    await expect.poll(() => view()?.dataset["kind"]).toBe("code");
    expect(pressed()).toEqual([2]);
  });

  test("a mark the follower makes itself stays until the presenter's next change of marks", async () => {
    const { controller, address } = await mountDeck();
    const { send } = follow(controller);
    controller.goTo(address("Code"));
    send({ op: "focus-open", slide: address("Code"), code: 2 }, { op: "focus-lines", lines: [1] });
    await userEvent.click(lines()[3]!);
    expect(pressed()).toEqual([1, 4]);
    // The laser moving is not a change of marks.
    send({ op: "laser", x: 0.5, y: 0.5 });
    expect(pressed()).toEqual([1, 4]);
    send({ op: "focus-lines", lines: [2] });
    expect(pressed()).toEqual([2]);
  });
});

const named = (page: string, n: number) => ({
  op: "focus-open" as const,
  slide: page,
  code: n,
});

describe("which listing a follower opens when its pages are cut elsewhere (decision 106)", () => {
  test("a listing is numbered across the section: the follower opens it from its own page, and nothing else", async () => {
    const { controller } = await mountDeck(MANY);
    const pages = controller
      .slides()
      .filter((s) => s.address.startsWith("many/"))
      .map((s) => s.address);
    expect(pages.length, "the section paginates").toBeGreaterThan(1);
    const { send } = follow(controller);

    // The last listing sits on the last page here; the presenter named it from its first page.
    const last = pages.at(-1)!;
    controller.goTo(pages[0]!);
    send(named(pages[0]!, 6));
    expect(view(), "that listing is not on the page this follower shows").toBeNull();
    controller.goTo(last);
    await expect.poll(() => view()?.dataset["kind"]).toBe("code");
    expect(lines()[0]!.textContent).toContain("listing F line 1");
    send({ op: "focus-close" });

    // Named from the last page, it is still the same listing; the first page holds listing A.
    controller.goTo(pages[0]!);
    send(named(last, 1));
    expect(view()?.dataset["kind"]).toBe("code");
    expect(lines()[0]!.textContent).toContain("listing A line 1");
  });
});
