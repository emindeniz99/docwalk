import { afterEach, expect, test, vi } from "vitest";
import { m } from "../paraglide/messages.js";
import { renderDiagrams } from "./mermaid";

// The Mermaid chunk can fail to load (offline before it was cached, a failed
// deploy). While `failing` is set, `initialize`, the first thing `loadMermaid`
// does with the imported module, throws, so the promise it builds from
// `import("mermaid")` rejects as it does when the chunk is missing. The
// message carries a URL with a hash, as the browser's own does.
//
// A load that succeeded stays loaded for the page, as in the app, and
// `vi.resetModules()` gives no fresh copy of `mermaid.ts` in browser mode, so
// only the last test of this file recovers.
const FAILURE =
  "Failed to fetch dynamically imported module: https://docwalk.example/assets/mermaid-3f9a1c.js";
const control = vi.hoisted(() => ({ failing: false }));
vi.mock("mermaid", async (importOriginal) => {
  const real = await importOriginal<typeof import("mermaid")>();
  const mermaid = new Proxy(real.default, {
    get(target, key, receiver) {
      if (control.failing && key === "initialize") throw new TypeError(FAILURE);
      const value: unknown = Reflect.get(target, key, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { ...real, default: mermaid };
});

afterEach(() => {
  document.body.replaceChildren();
  control.failing = false;
});

/** A root holding one ```mermaid block per source, as rendered Markdown has them. */
function rootWith(...sources: string[]): HTMLElement {
  const root = document.createElement("div");
  for (const source of sources) {
    const pre = document.createElement("pre");
    const code = document.createElement("code");
    code.className = "language-mermaid";
    code.textContent = source;
    pre.append(code);
    root.append(pre);
  }
  document.body.append(root);
  return root;
}

const FIRST = "flowchart LR\n  a --> b";
const SECOND = "flowchart TD\n  c --> d";
const BROKEN = "flowchart LR\n  a -->";
const LOAD_NOTE = () => m.diagram_error({ reason: m.diagram_load_failed() });

test("a diagram whose code did not load shows the note and its source, and the rest go on", async () => {
  // Decision 146 and rule 3: the figure used to stay empty with no note and
  // renderDiagrams rejected, leaving the next blocks of the root untouched.
  control.failing = true;
  const root = rootWith(FIRST, SECOND);
  const results = await renderDiagrams(root);
  expect(results.map((r) => r.ok)).toEqual([false, false]);
  const hosts = [...root.querySelectorAll<HTMLElement>("figure.docwalk-diagram")];
  expect(hosts).toHaveLength(2);
  expect(root.querySelector("pre > code.language-mermaid")).toBeNull();
  hosts.forEach((host, i) => {
    expect(host.classList.contains("docwalk-diagram-error")).toBe(true);
    expect(host.querySelector("p.docwalk-diagnostic")?.textContent).toBe(LOAD_NOTE());
    expect(host.querySelector("pre")?.textContent).toBe([FIRST, SECOND][i]);
    expect(host.querySelector("svg")).toBeNull();
  });
});

test("the note never shows the import error, which can hold a URL or a stack", async () => {
  // The browser's message names the chunk's hashed URL; the reader needs to
  // know the code did not load, not where it lives.
  control.failing = true;
  const root = rootWith(FIRST);
  await renderDiagrams(root);
  const text = root.querySelector("p.docwalk-diagnostic")?.textContent ?? "";
  expect(text).not.toBe("");
  expect(text).not.toContain("Failed to fetch");
  expect(text).not.toContain("https://");
  expect(text).not.toContain("mermaid-3f9a1c");
});

test("a failed load is not kept, and a root rendered during it draws when rendered again", async () => {
  // A rejected import kept for the page's life meant no diagram could be
  // drawn again until a reload, even once the connection was back. The map
  // draws a frame's diagrams in place and asks again later (decision 144);
  // by then the source block is gone, so the host keeps its source and a
  // second render of the same root draws it once the code loads.
  control.failing = true;
  const during = rootWith(FIRST, BROKEN, SECOND);
  expect((await renderDiagrams(during)).map((r) => r.ok)).toEqual([false, false, false]);
  expect(during.querySelectorAll(".docwalk-diagram-error")).toHaveLength(3);
  control.failing = false;

  // A new root after the failure loads the code and draws.
  const after = rootWith(SECOND, FIRST);
  expect(await renderDiagrams(after)).toEqual([{ ok: true }, { ok: true }]);
  expect(after.querySelectorAll("figure.docwalk-diagram svg")).toHaveLength(2);
  expect(after.querySelector(".docwalk-diagram-error, .docwalk-diagnostic")).toBeNull();

  // The root from the failure draws its hosts in place, in document order.
  const again = await renderDiagrams(during);
  expect(again.map((r) => r.ok)).toEqual([true, false, true]);
  const hosts = [...during.querySelectorAll<HTMLElement>("figure.docwalk-diagram")];
  expect(hosts).toHaveLength(3);
  for (const host of [hosts[0], hosts[2]]) {
    expect(host?.querySelector("svg")).not.toBeNull();
    expect(host?.classList.contains("docwalk-diagram-error")).toBe(false);
    expect(host?.querySelector(".docwalk-diagnostic")).toBeNull();
  }
  // The diagram that fails to parse now shows its parse error, not the load note.
  expect(hosts[1]?.classList.contains("docwalk-diagram-error")).toBe(true);
  expect(hosts[1]?.querySelector(".docwalk-diagnostic")?.textContent).not.toBe(LOAD_NOTE());
  expect(hosts[1]?.querySelector("pre")?.textContent).toBe(BROKEN);
  // A third render finds nothing left to draw: a parse failure is not tried again.
  expect(await renderDiagrams(during)).toEqual([]);
});
