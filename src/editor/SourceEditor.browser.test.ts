import { undo } from "@codemirror/commands";
import { EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { afterEach, describe, expect, test, vi } from "vitest";
import "virtual:docwalk-tokens.css";
import "../styles.css";
import { SourceEditor } from "./SourceEditor";
import type { SourceEditorProps } from "./types";

let root: Root | null = null;
let frame: HTMLElement | null = null;

afterEach(() => {
  root?.unmount();
  frame?.remove();
  root = frame = null;
});

const baseProps: SourceEditorProps = { value: "", onChange: () => {}, label: "Markdown source" };

/** Mounts the editor in a box of real size, so scrolling and layout are measurable. */
function mount(props: Partial<SourceEditorProps>) {
  frame = document.createElement("div");
  Object.assign(frame.style, { display: "flex", width: "600px", height: "240px" });
  document.body.append(frame);
  root = createRoot(frame);
  const render = (next: Partial<SourceEditorProps>) =>
    flushSync(() => root!.render(createElement(SourceEditor, { ...baseProps, ...props, ...next })));
  render({});
  const content = frame.querySelector<HTMLElement>(".cm-content")!;
  const view = EditorView.findFromDOM(content)!;
  return { view, content, render, frame };
}

const lines = (n: number) => Array.from({ length: n }, (_, i) => `Line ${i + 1}`).join("\n");

/** A fresh array with the same content on every call, as a shell that rebuilds it per render. */
const notes = () => [{ line: 2, message: "Too tall", severity: "warning" as const }];

describe("SourceEditor (CodeMirror 6)", () => {
  test("typing reports the new text, so the preview can re-render from it", () => {
    const seen: string[] = [];
    const { view } = mount({ value: "# Title\n", onChange: (v) => seen.push(v) });
    view.dispatch({ changes: { from: 8, insert: "Body" }, userEvent: "input.type" });
    expect(seen).toEqual(["# Title\nBody"]);
  });

  test("the parent echoing the typed text back keeps the cursor and the undo history", () => {
    let value = "alpha\nbeta\n";
    const { view, render } = mount({ value, onChange: (v) => (value = v) });
    view.dispatch({
      changes: { from: 5, insert: "!" },
      selection: EditorSelection.cursor(6),
      userEvent: "input.type",
    });
    // A controlled parent re-renders with exactly what it was told; a naive
    // implementation would replace the document and jump the cursor to 0.
    render({ value });
    expect(view.state.doc.toString()).toBe("alpha!\nbeta\n");
    expect(view.state.selection.main.head).toBe(6);
    // The same echo as a fresh string (not the same reference) is still a no-op.
    render({ value: `${value}` });
    expect(view.state.selection.main.head).toBe(6);
    // Undo still knows the typed "!", so Ctrl+Z works after every keystroke's echo.
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe("alpha\nbeta\n");
  });

  test("a new value from outside replaces the document without being echoed as an edit", () => {
    const seen: string[] = [];
    const { view, render } = mount({ value: "old text", onChange: (v) => seen.push(v) });
    render({ value: "# A different document\n\nWith a body.\n" });
    expect(view.state.doc.toString()).toBe("# A different document\n\nWith a body.\n");
    // Reporting the parent's own value back would loop or clobber newer typing.
    expect(seen).toEqual([]);
  });

  test("the cursor line is reported 1-based and only when it changes, so the preview follows it", () => {
    const reported: number[] = [];
    const { view } = mount({ value: lines(5), onCursorLine: (l) => reported.push(l) });
    view.dispatch({ selection: EditorSelection.cursor(view.state.doc.line(3).from) });
    view.dispatch({ selection: EditorSelection.cursor(view.state.doc.line(3).from + 2) });
    view.dispatch({ selection: EditorSelection.cursor(0) });
    expect(reported).toEqual([3, 1]);
  });

  test("revealLine scrolls that line into view and highlights it", async () => {
    const { view, render, content } = mount({ value: lines(300) });
    expect(view.scrollDOM.scrollTop).toBe(0);
    render({ revealLine: 200 });
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const top = view.lineBlockAt(view.state.doc.line(200).from).top;
    const { scrollTop, clientHeight } = view.scrollDOM;
    expect(top).toBeGreaterThanOrEqual(scrollTop);
    expect(top).toBeLessThan(scrollTop + clientHeight);
    // The highlight is how the user finds the line among 300 after the jump.
    expect(content.querySelector(".dw-reveal")?.textContent).toBe("Line 200");
  });

  test("the reveal highlight still fades when the parent resets revealLine to null right after", () => {
    // Resetting to null is how a shell lets the same outline item be clicked
    // twice; a highlight that never clears would leave a stale marker behind.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const { render, content } = mount({ value: lines(5) });
      render({ revealLine: 4 });
      render({ revealLine: null });
      expect(content.querySelector(".dw-reveal")?.textContent).toBe("Line 4");
      vi.advanceTimersByTime(1300);
      expect(content.querySelector(".dw-reveal")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  test("a reveal past the end of the document lands on the last line instead of throwing", () => {
    const { render, content } = mount({ value: lines(3) });
    render({ revealLine: 99 });
    expect(content.querySelector(".dw-reveal")?.textContent).toBe("Line 3");
  });

  test("diagnostics mark their lines, put a marker in the gutter and are announced", () => {
    const { render, frame: box, content } = mount({ value: lines(6) });
    render({
      diagnostics: [
        { line: 2, message: "Diagram scaled to 40%", severity: "info" },
        { line: 5, message: "Code block taller than a slide", severity: "warning" },
      ],
    });
    const marked = [...content.querySelectorAll(".dw-note-line")];
    expect(marked.map((l) => l.firstChild?.textContent)).toEqual(["Line 2", "Line 5"]);
    expect(box.querySelectorAll(".dw-note-marker")).toHaveLength(2);
    expect(box.querySelector(".dw-note-warning")?.getAttribute("title")).toBe(
      "Code block taller than a slide",
    );
    // Gutters are aria-hidden, so the message also lives in the line itself for screen readers.
    expect(marked[1]?.querySelector(".dw-note-text")?.textContent).toContain(
      "Warning: Code block taller than a slide",
    );
    const status = box.querySelector('[role="status"]');
    expect(status?.textContent).toBe("2 notes in the source, on lines 2 and 5.");
  });

  test("diagnostics follow their line while text is inserted above it", () => {
    const { view, render, content } = mount({ value: lines(4) });
    render({ diagnostics: [{ line: 3, message: "Too tall", severity: "warning" }] });
    view.dispatch({ changes: { from: 0, insert: "New first line\n" } });
    expect(content.querySelector(".dw-note-line")?.firstChild?.textContent).toBe("Line 3");
  });

  test("a note stays marked when its line is joined onto the one above", () => {
    // Backspace at the start of a line moves its text up; the note must move
    // with it, not lose its highlight until the next report arrives.
    const { view, render, content, frame: box } = mount({ value: lines(4) });
    render({ diagnostics: [{ line: 3, message: "Too tall", severity: "warning" }] });
    const lineThree = view.state.doc.line(3).from;
    view.dispatch({ changes: { from: lineThree - 1, to: lineThree } });
    const marked = [...content.querySelectorAll(".dw-note-line")];
    expect(marked.map((l) => l.firstChild?.textContent)).toEqual(["Line 2Line 3"]);
    expect(marked[0]?.querySelector(".dw-note-text")?.textContent).toContain("Too tall");
    expect(box.querySelectorAll(".dw-note-marker")).toHaveLength(1);
  });

  test("re-sending the same diagnostics does not repeat the announcement", async () => {
    // A shell that rebuilds the array on every render would otherwise make a
    // screen reader repeat "2 notes..." after every keystroke.
    const { render, frame: box } = mount({ value: lines(4), diagnostics: notes() });
    const status = box.querySelector('[role="status"]')!;
    expect(status.textContent).toBe("1 note in the source, on line 2.");
    const changes: MutationRecord[] = [];
    const observer = new MutationObserver((records) => changes.push(...records));
    observer.observe(status, { childList: true, characterData: true, subtree: true });
    render({ diagnostics: notes() });
    await Promise.resolve();
    observer.disconnect();
    expect(changes).toHaveLength(0);
  });

  test("the editing surface carries the label, so screen readers name it", () => {
    const { content, render } = mount({ label: "Markdown source" });
    expect(content.getAttribute("aria-label")).toBe("Markdown source");
    expect(content.getAttribute("role")).toBe("textbox");
    render({ label: "Source of ledger.md" });
    expect(content.getAttribute("aria-label")).toBe("Source of ledger.md");
  });

  test("the editor takes the pane's height and scrolls inside it, not the page", () => {
    const { view, frame: box } = mount({ value: lines(300) });
    expect(view.dom.getBoundingClientRect().height).toBeCloseTo(box.clientHeight, 0);
    expect(view.scrollDOM.scrollHeight).toBeGreaterThan(view.scrollDOM.clientHeight);
  });
});
