import { undo } from "@codemirror/commands";
import { EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { editor as monaco, Range, Selection } from "monaco-editor/editor";
import { createElement, type ComponentType } from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { afterEach, describe, expect, test, vi } from "vitest";
import "virtual:docwalk-tokens.css";
import "../styles.css";
import { chooseLocale, LOCALE_KEY } from "../i18n/locale";
import { MonacoEditor } from "./monaco/MonacoEditor";
import { SourceEditor } from "./SourceEditor";
import type { SourceEditorProps } from "./types";

/**
 * The decision 4 contract, run against every editor behind it. The shell
 * swaps CodeMirror for Monaco (decision 53) without changing a line, so each
 * promise the shell relies on must hold for both: echoes keep the cursor and
 * undo, outside values are not echoed back, the cursor line is reported,
 * reveals scroll and highlight, diagnostics mark, follow and announce.
 *
 * A driver reads and drives one editor through its own API; the tests only
 * talk to drivers, so a third editor needs a driver, not new tests.
 */
interface Driver {
  /** A user edit replacing [from, to) with `text`, optionally leaving the cursor at `cursor`. */
  edit(from: number, to: number, text: string, cursor?: number): void;
  select(offset: number): void;
  lineStart(line: number): number;
  /** Undoes one step; false when there was nothing to undo. */
  undo(): boolean;
  text(): string;
  head(): number;
  scrollTop(): number;
  lineVisible(line: number): boolean;
  /** The text of the line carrying the reveal highlight, or null. */
  revealedLine(): string | null;
  /** The text of every line carrying a diagnostic, in order. */
  notedLines(): string[];
  /** The hover text of the gutter marker with that severity. */
  markerHover(severity: "info" | "warning"): string | null;
  /** What assistive technology is given for a diagnostic on that line. */
  assistiveNote(line: number): string | null;
  /** The element that takes focus and carries the accessible name. */
  textbox(): HTMLElement;
  editorHeight(): number;
  scrollSize(): { height: number; client: number };
}

interface Candidate {
  name: string;
  Component: ComponentType<SourceEditorProps>;
  attach(frame: HTMLElement): Driver;
}

const codemirror: Candidate = {
  name: "CodeMirror 6",
  Component: SourceEditor,
  attach(frame) {
    const content = frame.querySelector<HTMLElement>(".cm-content")!;
    const view = EditorView.findFromDOM(content)!;
    const noteLines = () => [...content.querySelectorAll(".dw-note-line")];
    return {
      edit: (from, to, insert, cursor) =>
        view.dispatch({
          changes: { from, to, insert },
          ...(cursor === undefined ? {} : { selection: EditorSelection.cursor(cursor) }),
          userEvent: "input.type",
        }),
      select: (offset) => view.dispatch({ selection: EditorSelection.cursor(offset) }),
      lineStart: (line) => view.state.doc.line(line).from,
      undo: () => undo(view),
      text: () => view.state.doc.toString(),
      head: () => view.state.selection.main.head,
      scrollTop: () => view.scrollDOM.scrollTop,
      lineVisible(line) {
        const top = view.lineBlockAt(view.state.doc.line(line).from).top;
        const { scrollTop, clientHeight } = view.scrollDOM;
        return top >= scrollTop && top < scrollTop + clientHeight;
      },
      revealedLine: () => content.querySelector(".dw-reveal")?.textContent ?? null,
      notedLines: () => noteLines().map((l) => l.firstChild?.textContent ?? ""),
      markerHover: (severity) =>
        frame.querySelector(`.dw-note-marker.dw-note-${severity}`)?.getAttribute("title") ?? null,
      assistiveNote(line) {
        const text = view.state.doc.line(line).text;
        const el = noteLines().find((l) => l.firstChild?.textContent === text);
        return el?.querySelector(".dw-note-text")?.textContent ?? null;
      },
      textbox: () => content,
      editorHeight: () => view.dom.getBoundingClientRect().height,
      scrollSize: () => ({
        height: view.scrollDOM.scrollHeight,
        client: view.scrollDOM.clientHeight,
      }),
    };
  },
};

const monacoCandidate: Candidate = {
  name: "Monaco",
  Component: MonacoEditor,
  attach(frame) {
    const editor = monaco.getEditors().find((e) => frame.contains(e.getContainerDomNode()))!;
    const model = editor.getModel()!;
    const decorations = (match: (o: monaco.IModelDecorationOptions) => boolean) =>
      (editor.getDecorationsInRange(model.getFullModelRange()) ?? [])
        .filter((d) => match(d.options))
        .toSorted((a, b) => a.range.startLineNumber - b.range.startLineNumber);
    const position = (offset: number) => model.getPositionAt(offset);
    return {
      edit(from, to, text, cursor) {
        const a = position(from);
        const b = position(to);
        editor.pushUndoStop();
        editor.executeEdits("keyboard", [
          { range: new Range(a.lineNumber, a.column, b.lineNumber, b.column), text },
        ]);
        editor.pushUndoStop();
        // The cursor offset is in the edited text, so it is placed after the edit.
        if (cursor !== undefined) this.select(cursor);
      },
      select(offset) {
        const p = position(offset);
        editor.setSelection(new Selection(p.lineNumber, p.column, p.lineNumber, p.column));
      },
      lineStart: (line) => model.getOffsetAt({ lineNumber: line, column: 1 }),
      undo() {
        const could = model.canUndo();
        void model.undo();
        return could;
      },
      text: () => model.getValue(),
      head: () => model.getOffsetAt(editor.getPosition()!),
      scrollTop: () => editor.getScrollTop(),
      lineVisible: (line) =>
        editor.getVisibleRanges().some((r) => r.startLineNumber <= line && line <= r.endLineNumber),
      revealedLine() {
        const [hit] = decorations((o) => o.className === "dw-reveal");
        return hit ? model.getLineContent(hit.range.startLineNumber) : null;
      },
      notedLines: () =>
        decorations((o) => o.className?.startsWith("dw-note-line") ?? false).map((d) =>
          model.getLineContent(d.range.startLineNumber),
        ),
      markerHover(severity) {
        const [hit] = decorations(
          (o) => o.glyphMarginClassName?.includes(`dw-note-${severity}`) ?? false,
        );
        const hover = hit?.options.glyphMarginHoverMessage;
        return hover && !Array.isArray(hover) ? (hover as { value: string }).value : null;
      },
      // F8 and the hover read Monaco's markers out to screen readers.
      assistiveNote: (line) =>
        monaco
          .getModelMarkers({ resource: model.uri })
          .filter((m) => m.startLineNumber <= line && line <= m.endLineNumber)
          .map((m) => m.message)
          .join("; ") || null,
      textbox: () => frame.querySelector<HTMLElement>("[aria-label][role='textbox'], textarea")!,
      editorHeight: () => frame.querySelector(".monaco-editor")!.getBoundingClientRect().height,
      scrollSize: () => ({
        height: editor.getScrollHeight(),
        client: editor.getLayoutInfo().height,
      }),
    };
  },
};

let root: Root | null = null;
let frame: HTMLElement | null = null;

afterEach(() => {
  root?.unmount();
  frame?.remove();
  root = frame = null;
});

const baseProps: SourceEditorProps = { value: "", onChange: () => {}, label: "Markdown source" };

const lines = (n: number) => Array.from({ length: n }, (_, i) => `Line ${i + 1}`).join("\n");

/** A fresh array with the same content on every call, as a shell that rebuilds it per render. */
const notes = () => [{ line: 2, message: "Too tall", severity: "warning" as const }];

/** Both editors paint decorations on the next frames; wait for them. */
const painted = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

describe.each([codemirror, monacoCandidate])("SourceEditor contract: $name", (candidate) => {
  /** Mounts the editor in a box of real size, so scrolling and layout are measurable. */
  function mount(props: Partial<SourceEditorProps>) {
    frame = document.createElement("div");
    Object.assign(frame.style, { display: "flex", width: "600px", height: "240px" });
    document.body.append(frame);
    root = createRoot(frame);
    const render = (next: Partial<SourceEditorProps>) =>
      flushSync(() =>
        root!.render(createElement(candidate.Component, { ...baseProps, ...props, ...next })),
      );
    render({});
    return { editor: candidate.attach(frame), render, frame };
  }

  test("typing reports the new text, so the preview can re-render from it", () => {
    const seen: string[] = [];
    const { editor } = mount({ value: "# Title\n", onChange: (v) => seen.push(v) });
    editor.edit(8, 8, "Body");
    expect(seen).toEqual(["# Title\nBody"]);
  });

  test("the parent echoing the typed text back keeps the cursor and the undo history", () => {
    let value = "alpha\nbeta\n";
    const { editor, render } = mount({ value, onChange: (v) => (value = v) });
    editor.edit(5, 5, "!", 6);
    // A controlled parent re-renders with exactly what it was told; a naive
    // implementation would replace the document and jump the cursor to 0.
    render({ value });
    expect(editor.text()).toBe("alpha!\nbeta\n");
    expect(editor.head()).toBe(6);
    // The same echo as a fresh string (not the same reference) is still a no-op.
    render({ value: `${value}` });
    expect(editor.head()).toBe(6);
    // Undo still knows the typed "!", so Ctrl+Z works after every keystroke's echo.
    expect(editor.undo()).toBe(true);
    expect(editor.text()).toBe("alpha\nbeta\n");
  });

  test("a new value from outside replaces the document without being echoed as an edit", () => {
    const seen: string[] = [];
    const { editor, render } = mount({ value: "old text", onChange: (v) => seen.push(v) });
    render({ value: "# A different document\n\nWith a body.\n" });
    expect(editor.text()).toBe("# A different document\n\nWith a body.\n");
    // Reporting the parent's own value back would loop or clobber newer typing.
    expect(seen).toEqual([]);
  });

  test("a different document starts a fresh undo history, so undo never brings back the previous one", () => {
    // Undo after opening file B used to restore file A's text into B, and the
    // workspace autosaved it over B half a second later.
    const seen: string[] = [];
    const { editor, render } = mount({
      value: "# File A\n\nsecret A text\n",
      documentId: 1,
      onChange: (v) => seen.push(v),
    });
    editor.edit(0, 0, "x");
    render({ value: "# File B\n", documentId: 2 });
    expect(editor.text()).toBe("# File B\n");
    editor.undo();
    expect(editor.text()).toBe("# File B\n");
    expect(seen).toEqual(["x# File A\n\nsecret A text\n"]);
  });

  test("an outside change to the same document (an agent's write) stays undoable, and the undo is reported", () => {
    const seen: string[] = [];
    const { editor, render } = mount({
      value: "draft\n",
      documentId: 1,
      onChange: (v) => seen.push(v),
    });
    render({ value: "draft\nagent line\n", documentId: 1 });
    expect(editor.undo()).toBe(true);
    expect(editor.text()).toBe("draft\n");
    // The parent hears the undo, so the preview and the saved text follow it.
    expect(seen).toEqual(["draft\n"]);
  });

  test("the cursor line is reported 1-based and only when it changes, so the preview follows it", () => {
    const reported: number[] = [];
    const { editor } = mount({ value: lines(5), onCursorLine: (l) => reported.push(l) });
    editor.select(editor.lineStart(3));
    editor.select(editor.lineStart(3) + 2);
    editor.select(0);
    expect(reported).toEqual([3, 1]);
  });

  test("revealLine scrolls that line into view and highlights it", async () => {
    const { editor, render, frame: box } = mount({ value: lines(300) });
    expect(editor.scrollTop()).toBe(0);
    render({ revealLine: 200 });
    await painted();
    expect(editor.lineVisible(200)).toBe(true);
    // The highlight is how the user finds the line among 300 after the jump.
    expect(editor.revealedLine()).toBe("Line 200");
    expect(box.querySelector(".dw-reveal")).not.toBeNull();
  });

  test("the reveal highlight still fades when the parent resets revealLine to null right after", () => {
    // Resetting to null is how a shell lets the same outline item be clicked
    // twice; a highlight that never clears would leave a stale marker behind.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const { editor, render } = mount({ value: lines(5) });
      render({ revealLine: 4 });
      render({ revealLine: null });
      expect(editor.revealedLine()).toBe("Line 4");
      vi.advanceTimersByTime(1300);
      expect(editor.revealedLine()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  test("a reveal past the end of the document lands on the last line instead of throwing", () => {
    const { editor, render } = mount({ value: lines(3) });
    render({ revealLine: 99 });
    expect(editor.revealedLine()).toBe("Line 3");
  });

  test("initialLine starts the cursor on that line and scrolls it into view, so an editor switch keeps the place", async () => {
    // The shell remounts the editor when the viewer picks the other one; a
    // cursor that restarts on line 1 loses the viewer's place in a long document.
    const reported: number[] = [];
    const { editor } = mount({
      value: lines(300),
      initialLine: 200,
      onCursorLine: (l) => reported.push(l),
    });
    await painted();
    expect(editor.head()).toBe(editor.lineStart(200));
    expect(editor.lineVisible(200)).toBe(true);
    // The shell passed the line in; echoing it back would be noise, not a move.
    expect(reported).toEqual([]);
    editor.select(editor.lineStart(3));
    expect(reported).toEqual([3]);
  });

  test("initialLine past the end of the document lands on the last line", () => {
    const { editor } = mount({ value: lines(3), initialLine: 99 });
    expect(editor.head()).toBe(editor.lineStart(3));
  });

  test("initialLine only decides where the editor starts: a later value does not move the cursor", () => {
    const { editor, render } = mount({ value: lines(5), initialLine: 2 });
    editor.select(editor.lineStart(4));
    render({ initialLine: 2 });
    render({ initialLine: 5 });
    expect(editor.head()).toBe(editor.lineStart(4));
  });

  test("notes are put back when a different document replaces the text", async () => {
    // A new document starts from a fresh state; the notes the shell already
    // sent for it must not disappear until the next report arrives.
    const sent = notes();
    const { editor, render } = mount({ value: lines(6), documentId: 1, diagnostics: sent });
    await painted();
    expect(editor.notedLines()).toEqual(["Line 2"]);
    render({ value: "Alpha\nBeta\nGamma\n", documentId: 2, diagnostics: sent });
    await painted();
    expect(editor.notedLines()).toEqual(["Beta"]);
  });

  test("diagnostics mark their lines, put a marker in the gutter and are announced", async () => {
    const { editor, render, frame: box } = mount({ value: lines(6) });
    render({
      diagnostics: [
        { line: 2, message: "Diagram scaled to 40%", severity: "info" },
        { line: 5, message: "Code block taller than a slide", severity: "warning" },
      ],
    });
    await painted();
    expect(editor.notedLines()).toEqual(["Line 2", "Line 5"]);
    expect(box.querySelectorAll(".dw-note-marker")).toHaveLength(2);
    expect(editor.markerHover("warning")).toBe("Code block taller than a slide");
    // Gutters are hidden from screen readers, so the message must reach them another way.
    expect(editor.assistiveNote(5)).toContain("Code block taller than a slide");
    const status = box.querySelector('[role="status"]');
    expect(status?.textContent).toBe("2 notes in the source, on lines 2 and 5.");
  });

  test("diagnostics follow their line while text is inserted above it", () => {
    const { editor, render } = mount({ value: lines(4) });
    render({ diagnostics: [{ line: 3, message: "Too tall", severity: "warning" }] });
    editor.edit(0, 0, "New first line\n");
    expect(editor.notedLines()).toEqual(["Line 3"]);
  });

  test("a note stays marked when its line is joined onto the one above", async () => {
    // Backspace at the start of a line moves its text up; the note must move
    // with it, not lose its highlight until the next report arrives.
    const { editor, render, frame: box } = mount({ value: lines(4) });
    render({ diagnostics: [{ line: 3, message: "Too tall", severity: "warning" }] });
    const lineThree = editor.lineStart(3);
    editor.edit(lineThree - 1, lineThree, "");
    await painted();
    expect(editor.notedLines()).toEqual(["Line 2Line 3"]);
    expect(editor.assistiveNote(2)).toContain("Too tall");
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
    const { editor, render } = mount({ label: "Markdown source" });
    expect(editor.textbox().getAttribute("aria-label")).toBe("Markdown source");
    expect(editor.textbox().getAttribute("role")).toBe("textbox");
    render({ label: "Source of ledger.md" });
    expect(editor.textbox().getAttribute("aria-label")).toBe("Source of ledger.md");
  });

  test("the editor takes the pane's height and scrolls inside it, not the page", () => {
    const { editor, frame: box } = mount({ value: lines(300) });
    expect(editor.editorHeight()).toBeCloseTo(box.clientHeight, 0);
    const { height, client } = editor.scrollSize();
    expect(height).toBeGreaterThan(client);
  });
});

describe("CodeMirror's own words (decision 56)", () => {
  afterEach(() => {
    chooseLocale("en");
    localStorage.removeItem(LOCALE_KEY);
  });

  test("the search panel's words follow a language switch made while the editor is open", async () => {
    // The view keeps the phrases it was built with: rebuilding it on mount
    // dropped the scroll to `initialLine`, so only a switch hands it new ones.
    frame = document.createElement("div");
    document.body.append(frame);
    root = createRoot(frame);
    flushSync(() => root!.render(createElement(SourceEditor, { ...baseProps, value: lines(3) })));
    const view = EditorView.findFromDOM(frame.querySelector<HTMLElement>(".cm-content")!)!;
    expect(view.state.phrase("Find")).toBe("Find");
    chooseLocale("tr");
    await expect.poll(() => view.state.phrase("Find")).toBe("Bul");
    chooseLocale("en");
    await expect.poll(() => view.state.phrase("Find")).toBe("Find");
  });
});
