import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { DeckController, SlideInfo } from "../deck/controller";
import { useUrlSync, type UrlSyncOptions } from "./useUrlSync";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** A deck of `<id>/<page>` slides that behaves like the reveal.js controller. */
function fakeController(addresses: string[]) {
  const slides: SlideInfo[] = addresses.map((address, index) => {
    const [sectionId = "", page = "1"] = address.split("/");
    return {
      index,
      address,
      sectionId,
      page: Number(page),
      title: sectionId,
      flagged: false,
      note: null,
      text: "",
    };
  });
  const listeners = new Set<(slide: SlideInfo) => void>();
  let index = 0;
  const show = (i: number) => {
    index = i;
    for (const listener of listeners) listener(slides[i]!);
  };
  const controller: DeckController = {
    slides: () => slides,
    current: () => slides[index] ?? null,
    goTo: vi.fn<(address: string) => boolean>((address) => {
      const target = slides.find((s) => s.address === address || s.address === `${address}/1`);
      if (!target) return false;
      show(target.index);
      return true;
    }),
    next: () => show(Math.min(index + 1, slides.length - 1)),
    prev: () => show(Math.max(index - 1, 0)),
    onChange(listener) {
      listeners.add(listener);
      listener(slides[index]!);
      return () => listeners.delete(listener);
    },
    stage: () => document.body,
  };
  return controller;
}

const DECK = ["intro/1", "failure-handling/1", "failure-handling/2", "rollout/1"];

let root: Root | null = null;
let original = "";

beforeEach(() => {
  original = window.location.href;
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  // The test page's own URL; restore it so later tests start clean.
  window.history.replaceState(null, "", original);
});

/** Sets the URL the "page" was opened with, without adding a history entry. */
function openAt(search: string, hash: string) {
  const url = new URL(original);
  url.search = search;
  url.hash = hash;
  window.history.replaceState(null, "", url);
}

const baseOptions: UrlSyncOptions = {
  controller: null,
  documentId: 0,
  level: "auto",
  view: "edit",
  onLevel: () => {},
  onView: () => {},
};

function Harness(props: UrlSyncOptions) {
  useUrlSync(props);
  return null;
}

function mount(options: Partial<UrlSyncOptions>) {
  let current = { ...baseOptions, ...options };
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const render = (next: Partial<UrlSyncOptions> = {}) => {
    current = { ...current, ...next };
    act(() => root!.render(h(Harness, current)));
  };
  render();
  return render;
}

const nextHashChange = () =>
  new Promise<void>((resolve) =>
    window.addEventListener("hashchange", () => resolve(), { once: true }),
  );

describe("useUrlSync", () => {
  test("a link with a slide address opens the deck on that slide once it is ready", () => {
    openAt("", "#failure-handling/2");
    const render = mount({});
    const controller = fakeController(DECK);
    render({ controller });
    expect(controller.goTo).toHaveBeenCalledWith("failure-handling/2");
    expect(controller.current()?.address).toBe("failure-handling/2");
    // Subscribing reports the current slide; the hash must still name it, not the first slide.
    expect(window.location.hash).toBe("#failure-handling/2");
  });

  test("a GitHub heading anchor opens that section's first page", () => {
    openAt("", "#rollout");
    const controller = fakeController(DECK);
    mount({ controller });
    expect(controller.current()?.address).toBe("rollout/1");
    expect(window.location.hash).toBe("#rollout/1");
  });

  test("a page that no longer exists after repagination falls back to its section", () => {
    openAt("", "#failure-handling/7");
    const controller = fakeController(DECK);
    mount({ controller });
    expect(controller.current()?.address).toBe("failure-handling/1");
  });

  test("each slide change replaces the history entry, so Back leaves the deck instead of stepping slides", () => {
    openAt("", "");
    const controller = fakeController(DECK);
    mount({ controller });
    const before = window.history.length;
    act(() => controller.next());
    act(() => controller.next());
    expect(window.location.hash).toBe("#failure-handling/2");
    expect(window.history.length).toBe(before);
  });

  test("editing the hash moves the deck, so a pasted link works in an open tab", async () => {
    openAt("", "");
    const controller = fakeController(DECK);
    mount({ controller });
    const changed = nextHashChange();
    window.location.hash = "#rollout/1";
    await changed;
    expect(controller.current()?.address).toBe("rollout/1");
  });

  test("Back and Forward move the deck, because popstate can change the hash without a hashchange we rely on", () => {
    openAt("", "");
    const controller = fakeController(DECK);
    mount({ controller });
    // replaceState fires no event; dispatch popstate alone to prove that
    // listener drives the deck by itself.
    window.history.replaceState(null, "", "#failure-handling/2");
    act(() => window.dispatchEvent(new PopStateEvent("popstate")));
    expect(controller.current()?.address).toBe("failure-handling/2");
  });

  test("a rebuilt deck reopens on the slide in the hash, and the old deck no longer writes the URL", () => {
    openAt("", "");
    const first = fakeController(DECK);
    const render = mount({ controller: first });
    act(() => first.goTo("failure-handling/2"));
    expect(window.location.hash).toBe("#failure-handling/2");

    // An edit or a level change rebuilds the deck: null while building, then a new one at slide 1.
    render({ controller: null });
    const second = fakeController(DECK);
    render({ controller: second });
    expect(second.current()?.address).toBe("failure-handling/2");

    act(() => first.goTo("rollout/1"));
    expect(window.location.hash).toBe("#failure-handling/2");
  });

  test("renaming the current slide's heading keeps the deck on that slide, not the cover", () => {
    // Typing in a heading changes its slug, so the address in the hash no
    // longer exists in the rebuilt deck. Jumping to slide 1 on every keystroke
    // would throw the writer out of the slide they are editing.
    openAt("", "");
    const first = fakeController(DECK);
    const render = mount({ controller: first });
    act(() => first.goTo("failure-handling/2"));
    render({ controller: null });
    const renamed = fakeController([
      "intro/1",
      "failure-handlingx/1",
      "failure-handlingx/2",
      "rollout/1",
    ]);
    render({ controller: renamed });
    expect(renamed.current()?.address).toBe("failure-handlingx/2");
    expect(window.location.hash).toBe("#failure-handlingx/2");
  });

  test("renaming the first section's heading also keeps its slide, anchored on the section after it", () => {
    openAt("", "");
    const first = fakeController(DECK);
    const render = mount({ controller: first });
    render({ controller: null });
    const renamed = fakeController([
      "introduction/1",
      "failure-handling/1",
      "failure-handling/2",
      "rollout/1",
    ]);
    act(() => renamed.goTo("rollout/1"));
    render({ controller: renamed });
    expect(renamed.current()?.address).toBe("introduction/1");
  });

  test("another document that shares no section with the old one opens on its first slide", () => {
    // The rename fallback must not carry a slide position into an unrelated document.
    openAt("", "");
    const first = fakeController(DECK);
    const render = mount({ controller: first });
    act(() => first.goTo("rollout/1"));
    render({ controller: null });
    const other = fakeController(["alpha/1", "beta/1", "gamma/1", "delta/1"]);
    render({ controller: other });
    expect(other.current()?.address).toBe("alpha/1");
  });

  test("another document opens on its first slide even when it shares section ids with the old one", () => {
    // Two projects from one template, or two talks that both have a Summary:
    // the old address named a slide in the new document too, which then
    // opened mid-deck instead of on its cover.
    openAt("", "");
    const first = fakeController(DECK);
    const render = mount({ controller: first, documentId: 1 });
    act(() => first.goTo("failure-handling/2"));
    expect(window.location.hash).toBe("#failure-handling/2");
    render({ controller: null, documentId: 2 });
    const other = fakeController(DECK);
    render({ controller: other });
    expect(other.current()?.address).toBe("intro/1");
    expect(window.location.hash).toBe("#intro/1");
  });

  test("a document opened over a #doc= link starts on its first slide, not the old slide kept in memory", () => {
    openAt("", "#doc=eJzLSM3JyQcABiwCFQ");
    const first = fakeController(DECK);
    const render = mount({ controller: first, documentId: 1 });
    act(() => first.goTo("rollout/1"));
    render({ controller: null, documentId: 2 });
    const pasted = fakeController(DECK);
    render({ controller: pasted });
    expect(pasted.current()?.address).toBe("intro/1");
  });

  test("the first document of the page still opens on the link's slide", () => {
    // A ?src= link or a reload: the address in the hash is the reason for the link.
    openAt("", "#rollout/1");
    const render = mount({ controller: null, documentId: 0 });
    render({ documentId: 1 });
    const controller = fakeController(DECK);
    render({ controller });
    expect(controller.current()?.address).toBe("rollout/1");
  });

  test("under a #doc= fragment a rebuilt deck stays on the viewer's slide, though the hash cannot hold it", () => {
    // The share fragment keeps the hash, so the address lives only in memory;
    // without it every edit of a shared document snapped back to the cover.
    openAt("", "#doc=eJzLSM3JyQcABiwCFQ");
    const first = fakeController(DECK);
    const render = mount({ controller: first });
    act(() => first.goTo("failure-handling/2"));
    render({ controller: null });
    const second = fakeController(DECK);
    render({ controller: second });
    expect(second.current()?.address).toBe("failure-handling/2");
    expect(window.location.hash).toBe("#doc=eJzLSM3JyQcABiwCFQ");
  });

  test("a #doc= share fragment survives slide changes, so the shared document is not lost", () => {
    openAt("", "#doc=eJzLSM3JyQcABiwCFQ");
    const controller = fakeController(DECK);
    mount({ controller });
    act(() => controller.next());
    expect(window.location.hash).toBe("#doc=eJzLSM3JyQcABiwCFQ");
    expect(controller.goTo).not.toHaveBeenCalled();
  });

  test("level and view in the link are handed to the app on mount", () => {
    openAt("?level=1,3&view=present", "");
    const onLevel = vi.fn<UrlSyncOptions["onLevel"]>();
    const onView = vi.fn<UrlSyncOptions["onView"]>();
    mount({ onLevel, onView });
    expect(onLevel).toHaveBeenCalledWith([1, 3]);
    expect(onView).toHaveBeenCalledWith("present");
  });

  test("the app's defaults on first render do not overwrite the link's settings", () => {
    openAt("?level=2&src=x", "");
    mount({ level: "auto", view: "edit" });
    expect(window.location.search).toBe("?level=2&src=x");
  });

  test("changing level or view writes them to the query without adding history entries", () => {
    openAt("?src=x", "");
    const render = mount({});
    const before = window.history.length;
    render({ level: [2, 3], view: "document" });
    const params = new URL(window.location.href).searchParams;
    expect(params.get("level")).toBe("2,3");
    expect(params.get("view")).toBe("document");
    expect(params.get("src")).toBe("x");
    expect(window.history.length).toBe(before);
  });

  test("without history access (sandboxed iframe) the deck still works", () => {
    openAt("", "");
    const replace = vi.spyOn(window.history, "replaceState").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    try {
      const controller = fakeController(DECK);
      expect(() => mount({ controller })).not.toThrow();
      expect(() => act(() => controller.next())).not.toThrow();
      expect(controller.current()?.address).toBe("failure-handling/1");
    } finally {
      replace.mockRestore();
    }
  });

  test("unmounting stops following the URL, so a closed deck is not driven by stale listeners", async () => {
    openAt("", "");
    const controller = fakeController(DECK);
    mount({ controller });
    act(() => root?.unmount());
    root = null;
    const changed = nextHashChange();
    window.location.hash = "#rollout/1";
    await changed;
    expect(controller.current()?.address).toBe("intro/1");
  });
});
