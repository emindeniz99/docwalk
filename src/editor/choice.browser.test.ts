import { afterEach, describe, expect, test } from "vitest";
import { EDITOR_KEY, readEditorChoice, setEditorChoice } from "./choice";

afterEach(() => setEditorChoice("codemirror"));

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
