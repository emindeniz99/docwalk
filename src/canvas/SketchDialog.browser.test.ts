import { convertToExcalidrawElements } from "@excalidraw/excalidraw";
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import "virtual:docwalk-tokens.css";
import "../styles.css";
import { inlineFiles } from "./files";
import { diagramHash, documentKey, sketchKey } from "./identity";
import { SketchDialog } from "./SketchDialog";
import { deleteSketch, loadSketch, saveSketch } from "./store";

/**
 * Review pass 3: Excalidraw hands every image's `dataURL` to `new Image().src`
 * without checking the scheme, so a scene (opened, dropped, pasted or saved
 * earlier) whose image is `https://tracker.invalid/p.png` made the browser
 * fetch it with no click, and again on every reopening of the autosaved
 * sketch. That leaks the viewer's address and time to whoever made the file
 * and gets around decision 33's click-to-load image gate (rule 8).
 *
 * Every image load Excalidraw starts goes through `HTMLImageElement.src`;
 * the tests record each URL it is given. A scene carries a remote image and
 * an inline one: the inline one must load (so the scene really was read),
 * the remote one never.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const TRACKER = "https://tracker.invalid/p.png?u=viewer";
// A 1x1 transparent PNG.
const INLINE =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
const SOURCE = "flowchart TD\n  A --> B";
const DOC = { kind: "paste" } as const;

const sceneElements = () =>
  convertToExcalidrawElements([
    { type: "image", fileId: "remote" as never, x: 0, y: 0, width: 40, height: 40 },
    { type: "image", fileId: "inline" as never, x: 80, y: 0, width: 40, height: 40 },
  ]);
const sceneFiles = () => ({
  remote: { id: "remote", mimeType: "image/png", dataURL: TRACKER, created: 1 },
  inline: { id: "inline", mimeType: "image/png", dataURL: INLINE, created: 1 },
});
const sceneJson = (type: string) =>
  JSON.stringify({
    type,
    version: 2,
    source: "https://excalidraw.com",
    elements: sceneElements(),
    appState: {},
    files: sceneFiles(),
  });

let sources: string[] = [];
const srcDescriptor = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "src")!;
let root: Root | null = null;
let key = "";
/** Sketches of other documents that a test stores beside the open one. */
const OTHERS = [sketchKey("file:old.md", "h1"), sketchKey("file:new.md", "h2")];

/** Writes a record the way an earlier version saved it: straight into IndexedDB, unfiltered. */
function rawPut(record: object): Promise<void> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open("docwalk-canvas", 1);
    open.addEventListener("upgradeneeded", () =>
      open.result.createObjectStore("sketches", { keyPath: "key" }),
    );
    open.addEventListener("error", () => reject(open.error));
    open.addEventListener("success", () => {
      const tx = open.result.transaction("sketches", "readwrite");
      tx.objectStore("sketches").put(record);
      tx.addEventListener("complete", () => {
        open.result.close();
        resolve();
      });
      tx.addEventListener("error", () => reject(tx.error));
    });
  });
}

function rawGet(): Promise<{ files: Record<string, unknown> } | undefined> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open("docwalk-canvas", 1);
    open.addEventListener("error", () => reject(open.error));
    open.addEventListener("success", () => {
      const request = open.result.transaction("sketches").objectStore("sketches").get(key);
      request.addEventListener("success", () => {
        open.result.close();
        resolve(request.result as { files: Record<string, unknown> } | undefined);
      });
    });
  });
}

function mount() {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() =>
    root!.render(
      h(SketchDialog, {
        source: SOURCE,
        index: 1,
        documentSource: DOC,
        documentTitle: "Deck",
        onClose: () => {},
      }),
    ),
  );
}

async function canvasMounted() {
  await vi.waitFor(() => {
    if (!document.querySelector(".excalidraw canvas.interactive")) throw new Error("no canvas");
  });
  return document.querySelector<HTMLCanvasElement>(".excalidraw canvas.interactive")!;
}

async function mountSketch(stored: object) {
  await rawPut({ key, appState: {}, savedAt: 1, ...stored });
  mount();
  return canvasMounted();
}

/**
 * Every image URL Excalidraw was given that is not inline, once the scene's
 * inline image has loaded (so Excalidraw has read the scene's files).
 */
async function remoteImageRequests(): Promise<string[]> {
  await vi.waitFor(() => expect(sources).toContain(INLINE), { timeout: 5000 });
  await new Promise((resolve) => setTimeout(resolve, 100));
  return sources.filter((src) => !src.startsWith("data:") && !src.startsWith("blob:"));
}

beforeEach(async () => {
  key = sketchKey(documentKey(DOC), await diagramHash(SOURCE));
  sources = [];
  Object.defineProperty(HTMLImageElement.prototype, "src", {
    configurable: true,
    get: srcDescriptor.get!,
    set(this: HTMLImageElement, value: string) {
      sources.push(String(value));
      srcDescriptor.set!.call(this, value);
    },
  });
});

afterEach(async () => {
  act(() => root?.unmount());
  root = null;
  document.body.replaceChildren();
  Object.defineProperty(HTMLImageElement.prototype, "src", srcDescriptor);
  vi.restoreAllMocks();
  await deleteSketch(key);
  for (const other of OTHERS) await deleteSketch(other);
});

describe("remote images in sketches", () => {
  test("only data:image/ files are kept", () => {
    expect(
      Object.keys(
        inlineFiles({
          ...sceneFiles(),
          http: { dataURL: "http://x.test/a.png" },
          relative: { dataURL: "//x.test/a.png" },
          html: { dataURL: "data:text/html,<img src=x>" },
          missing: {},
        }),
      ),
    ).toEqual(["inline"]);
  });

  test("a sketch saved with a remote image reopens without requesting it, and is saved without it", async () => {
    await mountSketch({ elements: sceneElements(), files: sceneFiles() });
    expect(await remoteImageRequests()).toEqual([]);
    expect(Object.keys((await loadSketch(key))!.files)).toEqual(["inline"]);
  });

  test("a dropped .excalidraw file opens without its remote image", async () => {
    const canvas = await mountSketch({ elements: [], files: {} });
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(
      new File([sceneJson("excalidraw")], "received.excalidraw", { type: "application/json" }),
    );
    const box = canvas.getBoundingClientRect();
    canvas.dispatchEvent(
      new DragEvent("drop", {
        bubbles: true,
        cancelable: true,
        clientX: box.x + box.width / 2,
        clientY: box.y + box.height / 2,
        dataTransfer,
      }),
    );
    expect(await remoteImageRequests()).toEqual([]);
    // The autosave keeps what the canvas holds: no remote image to fetch on the next opening.
    await vi.waitFor(async () =>
      expect(Object.keys((await rawGet())?.files ?? {})).toContain("inline"),
    );
    expect(Object.keys((await rawGet())!.files)).toEqual(["inline"]);
  });

  test("a dropped image that is not a scene is still Excalidraw's to place", async () => {
    // The drop is caught to vet scenes; anything else is handed back to Excalidraw.
    const canvas = await mountSketch({ elements: [], files: {} });
    const png = await (await fetch(INLINE)).blob();
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(new File([png], "dot.png", { type: "image/png" }));
    const box = canvas.getBoundingClientRect();
    canvas.dispatchEvent(
      new DragEvent("drop", {
        bubbles: true,
        cancelable: true,
        clientX: box.x + box.width / 2,
        clientY: box.y + box.height / 2,
        dataTransfer,
      }),
    );
    // Wait for the PNG itself: Chromium's headless shell shows a JPEG data URL
    // first and the dropped PNG a moment later, so "any data:image/" passed
    // before the PNG arrived.
    await vi.waitFor(
      () => expect(sources.filter((src) => src.startsWith("data:image/png"))).not.toEqual([]),
      { timeout: 5000 },
    );
  });

  test("a pasted scene keeps only its inline image", async () => {
    const canvas = await mountSketch({ elements: [], files: {} });
    // Excalidraw takes a paste only with its canvas under the pointer and focus inside it.
    await userEvent.hover(canvas);
    canvas.closest<HTMLElement>(".excalidraw")!.focus();
    const clipboardData = new DataTransfer();
    clipboardData.setData("text/plain", sceneJson("excalidraw/clipboard"));
    document.dispatchEvent(new ClipboardEvent("paste", { clipboardData, bubbles: true }));
    expect(await remoteImageRequests()).toEqual([]);
  });

  test("Open in the canvas menu loads a scene without its remote image", async () => {
    await mountSketch({ elements: [], files: {} });
    const file = new File([sceneJson("excalidraw")], "received.excalidraw", {
      type: "application/json",
    });
    // Stand in for the file picker: the input the menu item opens gets the file.
    vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(function (
      this: HTMLInputElement,
    ) {
      if (this.type !== "file") return;
      const picked = new DataTransfer();
      picked.items.add(file);
      this.files = picked.files;
      this.dispatchEvent(new Event("change"));
    });
    await userEvent.click(document.querySelector<HTMLElement>(".main-menu-trigger")!);
    const open = [...document.querySelectorAll<HTMLElement>(".dropdown-menu-item")].find(
      (item) => item.textContent?.trim() === "Open",
    );
    expect(open).toBeDefined();
    await userEvent.click(open!);
    expect(await remoteImageRequests()).toEqual([]);
  });
});

const subtitle = () => document.querySelector(".docwalk-sketch-subtitle")?.textContent ?? "";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const byText = (selector: string, text: string) =>
  [...document.querySelectorAll<HTMLElement>(selector)].find((e) => e.textContent?.trim() === text);

/** Drops a .excalidraw file on the canvas: the scene changes, so Excalidraw reports a change. */
function dropScene(canvas: HTMLCanvasElement) {
  const dataTransfer = new DataTransfer();
  dataTransfer.items.add(
    new File([sceneJson("excalidraw")], "received.excalidraw", { type: "application/json" }),
  );
  const box = canvas.getBoundingClientRect();
  canvas.dispatchEvent(
    new DragEvent("drop", {
      bubbles: true,
      cancelable: true,
      clientX: box.x + box.width / 2,
      clientY: box.y + box.height / 2,
      dataTransfer,
    }),
  );
}

describe("when a sketch cannot be loaded or kept (decision 98)", () => {
  test("a page without crypto.subtle opens the sketch, unsaved, and does not wait forever", async () => {
    // Plain http outside localhost has no crypto.subtle; hashing the diagram threw and the dialog
    // stayed on "Converting…" with no canvas.
    Object.defineProperty(crypto, "subtle", { value: undefined, configurable: true });
    try {
      mount();
      await canvasMounted();
      await vi.waitFor(() => expect(document.querySelector(".docwalk-sketch-wait")).toBeNull(), {
        timeout: 20_000,
      });
      expect(subtitle()).toContain("secure connection");
    } finally {
      // Removes the own property, which uncovers the browser's.
      delete (crypto as { subtle?: unknown }).subtle;
    }
  });

  test("a stored sketch that cannot be read says so and is left as it was", async () => {
    // restore() throws on an element that is null; the dialog stayed on "Converting…".
    await rawPut({ key, appState: {}, savedAt: 1, elements: [null], files: {} });
    mount();
    await vi.waitFor(() =>
      expect(
        document.querySelector(".docwalk-sketch-wait.docwalk-diagnostic")?.textContent,
      ).toContain("could not be opened"),
    );
    expect((await loadSketch(key))?.elements).toEqual([null]);
  });

  test("a full storage says it is full, not that the browser blocks storage", async () => {
    const canvas = await mountSketch({ elements: [], files: {} });
    vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(() => {
      throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
    });
    dropScene(canvas);
    await vi.waitFor(() => expect(subtitle()).toContain("storage is full"), { timeout: 5000 });
    expect(subtitle()).not.toContain("blocks storage");
  });

  test("a change that leaves the saved scene as it is writes nothing", async () => {
    // Choosing a tool changes Excalidraw's state, not the scene, and every write rewrites the
    // record with all its images.
    const canvas = await mountSketch({ elements: [], files: {} });
    const put = vi.spyOn(IDBObjectStore.prototype, "put");
    dropScene(canvas);
    await vi.waitFor(
      () =>
        expect(
          put.mock.calls.some(([record]) =>
            (record as { elements: { type: string }[] }).elements.some((e) => e.type === "image"),
          ),
        ).toBe(true),
      { timeout: 5000 },
    );
    await sleep(800);
    const writes = put.mock.calls.length;

    canvas.closest<HTMLElement>(".excalidraw")!.focus();
    await userEvent.keyboard("r");
    await vi.waitFor(() =>
      expect(
        document.querySelector<HTMLInputElement>('input[data-testid="toolbar-rectangle"]')?.checked,
      ).toBe(true),
    );
    await sleep(800);
    expect(put.mock.calls.length).toBe(writes);
    expect(subtitle()).toContain("saved in this browser only");
  });
});

describe("Excalidraw's controls (decision 98)", () => {
  test("the menu button and the zoom button have names that match what they show", async () => {
    // Excalidraw 0.18.1 gives the menu button no name and labels the zoom button "Reset zoom"
    // while it reads "100%"; axe rejects both (button-name, label-content-name-mismatch).
    await page.viewport(1280, 800);
    await mountSketch({ elements: [], files: {} });
    const reset = () => document.querySelector<HTMLElement>(".reset-zoom-button")!;
    await vi.waitFor(() => expect(reset()).not.toBeNull());
    expect(document.querySelector(".main-menu-trigger")?.getAttribute("aria-label")).toBe(
      "Canvas menu",
    );
    const label = () => reset().getAttribute("aria-label") ?? "";
    await vi.waitFor(() => expect(label()).toContain(reset().textContent!.trim()));
    expect(label()).toContain("Reset zoom");

    const before = reset().textContent;
    await userEvent.click(document.querySelector<HTMLElement>(".zoom-in-button")!);
    await vi.waitFor(() => expect(reset().textContent).not.toBe(before));
    await vi.waitFor(() => expect(label()).toContain(reset().textContent!.trim()));
  });

  test("the Library's Browse libraries link, which leaves for another site, is not offered", async () => {
    await page.viewport(1280, 800);
    await mountSketch({ elements: [], files: {} });
    await userEvent.click(document.querySelector<HTMLElement>(".default-sidebar-trigger")!);
    await vi.waitFor(() =>
      expect(document.querySelector(".library-menu-browse-button")).not.toBeNull(),
    );
    expect(getComputedStyle(document.querySelector(".library-menu-browse-button")!).display).toBe(
      "none",
    );
  });
});

describe("the Saved sketches panel (decision 98)", () => {
  async function openPanel() {
    await rawPut({ key, appState: {}, savedAt: 3, elements: [], files: {} });
    await saveSketch({ key: OTHERS[0]!, elements: [], appState: {}, files: {}, savedAt: 1 });
    await saveSketch({ key: OTHERS[1]!, elements: [], appState: {}, files: {}, savedAt: 2 });
    mount();
    await canvasMounted();
    await userEvent.click(byText(".docwalk-sketch-header button", "Saved sketches")!);
    await vi.waitFor(() =>
      expect(document.querySelectorAll(".docwalk-sketch-store li").length).toBe(3),
    );
  }
  const rows = () => [...document.querySelectorAll<HTMLElement>(".docwalk-sketch-store li")];

  test("it lists every stored sketch by document and deletes the one asked for", async () => {
    await openPanel();
    expect(rows().map((row) => row.textContent)).toEqual([
      expect.stringContaining("paste"),
      expect.stringContaining("file:new.md"),
      expect.stringContaining("file:old.md"),
    ]);
    // The open sketch would be written again at the next change; it is marked, not offered.
    expect(rows()[0]!.textContent).toContain("open now");
    expect(byText(".docwalk-sketch-store li:first-child button", "Delete")).toBeUndefined();

    await userEvent.click(byText(".docwalk-sketch-store li:last-child button", "Delete")!);
    await vi.waitFor(() => expect(rows().length).toBe(2));
    expect(await loadSketch(OTHERS[0]!)).toBeNull();
    expect(await loadSketch(OTHERS[1]!)).not.toBeNull();
  });

  test("Delete all others asks first and never takes the open sketch", async () => {
    await openPanel();
    await userEvent.click(byText(".docwalk-sketch-store button", "Delete all others")!);
    expect(document.querySelector(".docwalk-sketch-store")?.textContent).toContain(
      "This cannot be undone.",
    );
    // Asked, not done.
    expect(await loadSketch(OTHERS[1]!)).not.toBeNull();

    await userEvent.click(byText(".docwalk-sketch-store button", "Keep them")!);
    expect(await loadSketch(OTHERS[1]!)).not.toBeNull();

    await userEvent.click(byText(".docwalk-sketch-store button", "Delete all others")!);
    await userEvent.click(byText(".docwalk-sketch-store button", "Delete them")!);
    await vi.waitFor(() => expect(rows().length).toBe(1));
    expect(await loadSketch(OTHERS[0]!)).toBeNull();
    expect(await loadSketch(OTHERS[1]!)).toBeNull();
    expect(await loadSketch(key)).not.toBeNull();
  });
});
