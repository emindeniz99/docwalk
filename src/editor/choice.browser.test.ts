import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, test } from "vitest";
import {
  EDITOR_KEY,
  readEditorChoice,
  setEditorChoice,
  useStoredEditorChoice,
} from "./choice";

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  root?.unmount();
  host?.remove();
  root = host = null;
  setEditorChoice("codemirror");
});

const store = (value: string | null) => ({
  getItem: (key: string) => (key === EDITOR_KEY ? value : null),
});

describe("stored editor choice (decision 53)", () => {
  test("Monaco only when the viewer picked it", () => {
    expect(readEditorChoice(store("monaco"))).toBe("monaco");
    expect(readEditorChoice(store(null))).toBe("codemirror");
  });

  test("anything unexpected falls back to CodeMirror, which works on every device", () => {
    // localStorage is writable by any script on the origin and survives
    // releases; a stale or garbled value must not leave the edit view empty.
    expect(readEditorChoice(store("Monaco"))).toBe("codemirror");
    expect(readEditorChoice(store("vim"))).toBe("codemirror");
    expect(readEditorChoice(undefined)).toBe("codemirror");
  });

  test("storage that throws (private mode, blocked cookies) still gives an editor", () => {
    const throwing = {
      getItem: () => {
        throw new DOMException("denied", "SecurityError");
      },
    };
    expect(readEditorChoice(throwing)).toBe("codemirror");
  });

  test("picking Monaco survives a reload; picking CodeMirror leaves nothing behind", () => {
    setEditorChoice("monaco");
    expect(readEditorChoice(localStorage)).toBe("monaco");
    // The default is not stored, so a viewer who goes back leaves no trace.
    setEditorChoice("codemirror");
    expect(localStorage.getItem(EDITOR_KEY)).toBeNull();
  });
});

describe("editor choice across tabs", () => {
  function Probe() {
    return createElement("output", null, useStoredEditorChoice());
  }

  function mountProbe() {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    flushSync(() => root!.render(createElement(Probe)));
    return host.querySelector("output")!;
  }

  /** What the browser sends the other tabs when a tab writes `localStorage`. */
  const fromOtherTab = (key: string | null, value: string | null) => {
    if (key === null) localStorage.clear();
    else if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
    window.dispatchEvent(
      new StorageEvent("storage", { key, newValue: value, storageArea: localStorage }),
    );
  };

  test("a pick made in another tab switches this tab too, so two windows never disagree", async () => {
    const shown = mountProbe();
    expect(shown.textContent).toBe("codemirror");
    fromOtherTab(EDITOR_KEY, "monaco");
    await expect.poll(() => shown.textContent).toBe("monaco");
    fromOtherTab(EDITOR_KEY, null);
    await expect.poll(() => shown.textContent).toBe("codemirror");
  });

  test("clearing site data in another tab returns this one to CodeMirror", async () => {
    const shown = mountProbe();
    setEditorChoice("monaco");
    await expect.poll(() => shown.textContent).toBe("monaco");
    fromOtherTab(null, null);
    await expect.poll(() => shown.textContent).toBe("codemirror");
  });

  test("another key changing in storage does not touch the choice", async () => {
    const shown = mountProbe();
    setEditorChoice("monaco");
    fromOtherTab("docwalk.locale", "tr");
    await Promise.resolve();
    expect(shown.textContent).toBe("monaco");
    localStorage.removeItem("docwalk.locale");
  });
});
