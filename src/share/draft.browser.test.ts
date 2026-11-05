import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { DocumentSource } from "../inputs/types";
import {
  clearDraft,
  DRAFT_DEBOUNCE_MS,
  draftWouldBeReplaced,
  holdDraft,
  loadDraft,
  releaseDraft,
  saveDraft,
  useDraftAutosave,
} from "./draft";
import { DRAFT_STORAGE_KEY } from "./types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;

function Autosave({ markdown, source }: { markdown: string; source: DocumentSource }) {
  useDraftAutosave(markdown, source);
  return null;
}

function render(markdown: string, source: DocumentSource) {
  if (!root) {
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  }
  act(() => root!.render(h(Autosave, { markdown, source })));
}

const stored = () => localStorage.getItem(DRAFT_STORAGE_KEY);

beforeEach(() => {
  localStorage.clear();
  // Each test starts as a fresh page that holds no draft.
  releaseDraft();
  vi.useFakeTimers();
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("draft autosave", () => {
  test("saves once typing pauses, not on every keystroke, so typing stays fast", () => {
    const paste: DocumentSource = { kind: "paste" };
    render("# D", paste);
    act(() => vi.advanceTimersByTime(DRAFT_DEBOUNCE_MS - 100));
    render("# Dr", paste);
    act(() => vi.advanceTimersByTime(DRAFT_DEBOUNCE_MS - 100));
    render("# Draft", paste);
    act(() => vi.advanceTimersByTime(DRAFT_DEBOUNCE_MS - 1));
    expect(stored()).toBeNull();

    act(() => vi.advanceTimersByTime(1));
    expect(loadDraft()).toEqual({ markdown: "# Draft", source: { kind: "paste" } });
  });

  test("a dropped file's draft keeps its name, so the banner can say where it came from", () => {
    render("# From a file", { kind: "file", name: "plan.md" });
    act(() => vi.advanceTimersByTime(DRAFT_DEBOUNCE_MS));
    expect(loadDraft()).toEqual({
      markdown: "# From a file",
      source: { kind: "file", name: "plan.md" },
    });
  });

  test.each<DocumentSource>([
    { kind: "url", url: "https://raw.githubusercontent.com/a/b/main/c.md", trusted: true },
    { kind: "repo", repo: "a/b", path: "c.md", ref: null },
    { kind: "sample" },
    { kind: "fragment" },
  ])("never saves a $kind document, which can be loaded again", (source) => {
    render("# Reloadable", source);
    act(() => vi.advanceTimersByTime(DRAFT_DEBOUNCE_MS * 3));
    expect(stored()).toBeNull();
  });

  test("hiding the page saves at once, so the last keystrokes before closing the tab survive", () => {
    render("# Last words", { kind: "paste" });
    act(() => {
      globalThis.dispatchEvent(new Event("pagehide"));
    });
    expect(loadDraft()?.markdown).toBe("# Last words");
  });

  test("switching away from the tab saves at once, because mobile browsers may discard it without pagehide", () => {
    render("# Backgrounded", { kind: "paste" });
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(loadDraft()?.markdown).toBe("# Backgrounded");
  });

  test("returning to the tab does not save early, so the debounce still holds while visible", () => {
    render("# Visible", { kind: "paste" });
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(stored()).toBeNull();
  });

  test("full storage does not crash the editor", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("full", "QuotaExceededError");
    });
    expect(() => {
      render("# Big", { kind: "paste" });
      act(() => vi.advanceTimersByTime(DRAFT_DEBOUNCE_MS));
    }).not.toThrow();
    expect(saveDraft("# Big", { kind: "paste" })).toBe(false);
  });
});

describe("the one draft slot", () => {
  const PRECIOUS = JSON.stringify({
    markdown: "# Pasted\n\nOnly copy.",
    source: { kind: "paste" },
  });

  test("an edited share-link document never overwrites or clears a draft this page did not open", () => {
    // A pasted draft exists nowhere else; fixing a typo in a colleague's link
    // must not destroy it behind the user's back.
    localStorage.setItem(DRAFT_STORAGE_KEY, PRECIOUS);
    expect(draftWouldBeReplaced()).toBe(true);
    render("# Shared doc, edited", { kind: "paste" });
    act(() => vi.advanceTimersByTime(DRAFT_DEBOUNCE_MS * 2));
    act(() => {
      globalThis.dispatchEvent(new Event("pagehide"));
    });
    expect(stored()).toBe(PRECIOUS);
    expect(saveDraft("  ", { kind: "paste" })).toBe(false);
    expect(stored()).toBe(PRECIOUS);
  });

  test("once this page holds the draft (opened it, or the user chose to replace it) edits save over it", () => {
    localStorage.setItem(DRAFT_STORAGE_KEY, PRECIOUS);
    holdDraft();
    expect(draftWouldBeReplaced()).toBe(false);
    render("# Edited draft", { kind: "paste" });
    act(() => vi.advanceTimersByTime(DRAFT_DEBOUNCE_MS));
    expect(loadDraft()?.markdown).toBe("# Edited draft");
  });

  test("an empty slot is free: the first save takes it, so a fresh browser keeps edits of a shared document", () => {
    render("# Shared doc, edited", { kind: "paste" });
    act(() => vi.advanceTimersByTime(DRAFT_DEBOUNCE_MS));
    expect(loadDraft()?.markdown).toBe("# Shared doc, edited");
    render("# Shared doc, edited more", { kind: "paste" });
    act(() => vi.advanceTimersByTime(DRAFT_DEBOUNCE_MS));
    expect(loadDraft()?.markdown).toBe("# Shared doc, edited more");
  });
});

describe("draft storage", () => {
  test("the stored record holds only the Markdown and the source kind, never a token", () => {
    const source = { kind: "paste", token: "ghp_secret" } as Parameters<typeof saveDraft>[1];
    saveDraft("# Doc", source);
    expect(JSON.parse(stored()!)).toEqual({ markdown: "# Doc", source: { kind: "paste" } });
  });

  test("a damaged or foreign record loads as no draft instead of crashing the app", () => {
    for (const raw of [
      "{not json",
      "42",
      '{"markdown":1}',
      '{"markdown":"x","source":{"kind":"url"}}',
    ]) {
      localStorage.setItem(DRAFT_STORAGE_KEY, raw);
      expect(loadDraft()).toBeNull();
    }
  });

  test("extra fields in a stored record are dropped on load", () => {
    localStorage.setItem(
      DRAFT_STORAGE_KEY,
      JSON.stringify({ markdown: "# Doc", source: { kind: "paste", token: "x" }, token: "y" }),
    );
    expect(loadDraft()).toEqual({ markdown: "# Doc", source: { kind: "paste" } });
  });

  test("clearing the document clears the draft, so an empty editor does not come back as a draft", () => {
    saveDraft("# Doc", { kind: "paste" });
    saveDraft("   \n", { kind: "paste" });
    expect(stored()).toBeNull();
  });

  test("clearDraft removes the draft", () => {
    saveDraft("# Doc", { kind: "paste" });
    clearDraft();
    expect(loadDraft()).toBeNull();
  });

  test("storage that throws on access (blocked site data) reads as no draft", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    expect(loadDraft()).toBeNull();
    expect(() => clearDraft()).not.toThrow();
  });
});
