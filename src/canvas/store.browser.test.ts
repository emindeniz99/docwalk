import { afterEach, describe, expect, test } from "vitest";
import { deleteSketch, listSketches, loadSketch, saveSketch, type StoredSketch } from "./store";

const sketch = (key: string, text: string): StoredSketch => ({
  key,
  elements: [{ type: "text", text }],
  appState: { scrollX: 10, scrollY: 20, zoom: { value: 1.5 } },
  files: {},
  savedAt: 1,
});

const KEYS = ["doc-a\nhash-1", "doc-a\nhash-2", "doc-b\nhash-1", "broken"];

afterEach(async () => {
  for (const key of KEYS) await deleteSketch(key);
});

describe("sketch store (decision 54)", () => {
  test("a saved sketch reopens with its scene and its view", async () => {
    // Reopen where you left: the elements and the scroll/zoom both come back.
    await saveSketch(sketch("doc-a\nhash-1", "edited"));
    const back = await loadSketch("doc-a\nhash-1");
    expect(back?.elements).toEqual([{ type: "text", text: "edited" }]);
    expect(back?.appState).toEqual({ scrollX: 10, scrollY: 20, zoom: { value: 1.5 } });
  });

  test("sketches of other diagrams and other documents stay apart", async () => {
    await saveSketch(sketch("doc-a\nhash-1", "a1"));
    await saveSketch(sketch("doc-a\nhash-2", "a2"));
    await saveSketch(sketch("doc-b\nhash-1", "b1"));
    expect((await loadSketch("doc-a\nhash-2"))?.elements).toEqual([{ type: "text", text: "a2" }]);
    expect((await loadSketch("doc-b\nhash-1"))?.elements).toEqual([{ type: "text", text: "b1" }]);
  });

  test("saving again replaces the sketch rather than adding a second one", async () => {
    await saveSketch(sketch("doc-a\nhash-1", "first"));
    await saveSketch(sketch("doc-a\nhash-1", "second"));
    expect((await loadSketch("doc-a\nhash-1"))?.elements).toEqual([
      { type: "text", text: "second" },
    ]);
  });

  test("no sketch yet reads as null, so the diagram is converted", async () => {
    expect(await loadSketch("doc-a\nhash-1")).toBeNull();
  });

  test("a record in a shape this version cannot read is ignored, not handed to Excalidraw", async () => {
    await saveSketch({ key: "broken", elements: "nope" } as unknown as StoredSketch);
    expect(await loadSketch("broken")).toBeNull();
  });

  test("the stored sketches are listed newest first with a size, so a viewer can choose what to delete (decision 89)", async () => {
    await saveSketch({ ...sketch("doc-a\nhash-1", "a1"), savedAt: 10 });
    await saveSketch({ ...sketch("doc-b\nhash-1", "b1".repeat(5000)), savedAt: 20 });
    // A record this version cannot read is not offered: the viewer could not tell what it is.
    await saveSketch({ key: "broken", elements: "nope" } as unknown as StoredSketch);
    const listed = (await listSketches()).filter((item) => KEYS.includes(item.key));
    expect(listed.map((item) => item.key)).toEqual(["doc-b\nhash-1", "doc-a\nhash-1"]);
    expect(listed.map((item) => item.savedAt)).toEqual([20, 10]);
    // The size follows the content: ten thousand characters of text weigh more than a few.
    expect(listed[0]!.bytes).toBeGreaterThan(10_000);
    expect(listed[1]!.bytes).toBeGreaterThan(0);
    expect(listed[1]!.bytes).toBeLessThan(listed[0]!.bytes);
  });
});
