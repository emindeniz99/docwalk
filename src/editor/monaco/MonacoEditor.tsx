import { editor as monaco, MarkerSeverity, Range } from "monaco-editor/editor";
// Only the editor features a Markdown author uses; `monaco-editor` itself would
// pull every language and language service into this chunk.
import "monaco-editor/features/clipboard/register";
import "monaco-editor/features/codicon/register";
import "monaco-editor/features/comment/register";
import "monaco-editor/features/contextmenu/register";
import "monaco-editor/features/cursorUndo/register";
import "monaco-editor/features/find/register";
import "monaco-editor/features/folding/register";
import "monaco-editor/features/gotoError/register";
import "monaco-editor/features/hover/register";
import "monaco-editor/features/linesOperations/register";
import "monaco-editor/features/multicursor/register";
import "monaco-editor/features/toggleTabFocusMode/register";
import "monaco-editor/features/wordOperations/register";
import "monaco-editor/languages/definitions/markdown/register";
// Self-hosted: Vite emits the worker as a file of this build, so CSP
// `worker-src 'self'` holds and nothing loads from a CDN (decision 53).
// oxlint-disable-next-line import/default -- Vite adds the default export for `?worker`.
import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import "../editor.css";
import "./monaco.css";
import {
  announceDiagnostics,
  clampLine,
  groupDiagnostics,
  type LineNotes,
  minimalChange,
} from "../sync";
import type { EditorDiagnostic, SourceEditorProps } from "../types";
import { escapeMarkdown } from "./escape";
import { monacoTheme, readPalette } from "./theme";

globalThis.MonacoEnvironment = { getWorker: () => new EditorWorker() };

/** How long a revealed line stays highlighted; the same as the CodeMirror editor. */
const REVEAL_MS = 1200;
const THEME = "docwalk";
const MARKER_OWNER = "docwalk";

/** Monaco has one theme for every editor on the page; rebuild it from the app's variables. */
function applyTheme() {
  monaco.defineTheme(THEME, monacoTheme(readPalette()));
  monaco.setTheme(THEME);
}

/** Re-applies the theme whenever light/dark changes: the viewer's pick or the system's. */
function followTheme(): () => void {
  applyTheme();
  const scheme = globalThis.matchMedia("(prefers-color-scheme: dark)");
  scheme.addEventListener("change", applyTheme);
  const observer = new MutationObserver(applyTheme);
  observer.observe(document.documentElement, { attributeFilter: ["data-theme"] });
  return () => {
    scheme.removeEventListener("change", applyTheme);
    observer.disconnect();
  };
}

/** One whole-line marker per note group, in Monaco's yellow-themed severities. */
function setMarkers(model: monaco.ITextModel, groups: readonly LineNotes[]) {
  monaco.setModelMarkers(
    model,
    MARKER_OWNER,
    groups.map((g) => ({
      severity: g.severity === "warning" ? MarkerSeverity.Warning : MarkerSeverity.Info,
      message: g.messages.join("\n"),
      startLineNumber: g.line,
      startColumn: 1,
      endLineNumber: g.line,
      endColumn: model.getLineMaxColumn(g.line),
    })),
  );
}

/** The mono type token, as the CodeMirror editor uses it. */
function monoFont() {
  const style = getComputedStyle(document.documentElement);
  const size = Number.parseFloat(style.getPropertyValue("--dw-type-mono-size")) || 13;
  const lineHeight = Number.parseFloat(style.getPropertyValue("--dw-type-mono-line-height")) || 1.7;
  const family = style.getPropertyValue("--dw-type-mono-family").trim() || "monospace";
  // Monaco reads a line height below 8 as a multiple of the font size.
  return { fontFamily: family, fontSize: size, lineHeight };
}

/**
 * The Markdown source editor as Monaco (decision 53), behind the same
 * SourceEditorProps contract as the CodeMirror one (decision 4). Controlled,
 * and an echo of the editor's own text is a no-op, so typing never loses the
 * cursor or the undo history.
 */
export function MonacoEditor({
  value,
  onChange,
  onCursorLine,
  initialLine,
  revealLine,
  diagnostics,
  label,
  documentId,
}: SourceEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.IStandaloneCodeEditor | null>(null);
  const documentRef = useRef(documentId);
  const statusRef = useRef<HTMLDivElement>(null);
  const notesRef = useRef<monaco.IEditorDecorationsCollection | null>(null);
  const revealRef = useRef<monaco.IEditorDecorationsCollection | null>(null);
  // The text the editor and the parent last agreed on; see SourceEditor.tsx.
  const syncedRef = useRef(value);
  const applyingParent = useRef(false);
  const lastLineRef = useRef<number | null>(null);
  const groupsRef = useRef<LineNotes[]>([]);
  const callbacks = useRef({ onChange, onCursorLine });
  useLayoutEffect(() => {
    callbacks.current = { onChange, onCursorLine };
  });
  const initial = useRef({ value, label, line: initialLine });
  const diagnosticsRef = useRef(diagnostics);
  useLayoutEffect(() => {
    diagnosticsRef.current = diagnostics;
  });

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const stopTheme = followTheme();
    // The same vertical breathing room as the CodeMirror editor's content.
    const space =
      Number.parseFloat(
        getComputedStyle(document.documentElement).getPropertyValue("--dw-space-lg"),
      ) || 0;
    const editor = monaco.create(host, {
      value: initial.current.value,
      language: "markdown",
      theme: THEME,
      ariaLabel: initial.current.label,
      ...monoFont(),
      automaticLayout: true,
      wordWrap: "on",
      minimap: { enabled: false },
      glyphMargin: true,
      lineNumbersMinChars: 3,
      scrollBeyondLastLine: false,
      renderLineHighlight: "all",
      // Tab moves focus, as in the CodeMirror editor, so the editor is never a
      // keyboard trap; Ctrl+M switches Tab back to indenting.
      tabFocusMode: true,
      // Markdown has no IntelliSense worth popping up while typing prose.
      quickSuggestions: false,
      wordBasedSuggestions: "off",
      suggestOnTriggerCharacters: false,
      occurrencesHighlight: "off",
      links: false,
      // Hovers and the find widget may overflow the narrow source pane.
      fixedOverflowWidgets: true,
      padding: { top: space, bottom: space },
    });
    const model = editor.getModel();
    // CodeMirror reports "\n" line breaks whatever the input used; so does this editor.
    model?.setEOL(monaco.EndOfLineSequence.LF);
    // Coloured brackets would add colours outside the design tokens. Standalone
    // Monaco reads this from the model; the editor option never reaches it.
    model?.updateOptions({
      bracketColorizationOptions: { enabled: false, independentColorPoolPerBracketType: false },
    });
    syncedRef.current = initial.current.value;
    editorRef.current = editor;
    notesRef.current = editor.createDecorationsCollection();
    revealRef.current = editor.createDecorationsCollection();
    // The shell can pass the line to start on (an editor switch keeps the
    // viewer's place); like a reveal, it lands in the middle of the pane. This
    // runs before the cursor listener exists: the shell passed the line in, so
    // reporting it back would not be a move.
    const start = clampLine(initial.current.line ?? 1, model?.getLineCount() ?? 1) ?? 1;
    if (start > 1) {
      editor.setPosition({ lineNumber: start, column: 1 });
      editor.revealLineInCenter(start, monaco.ScrollType.Immediate);
      lastLineRef.current = start;
    }

    const content = editor.onDidChangeModelContent(() => {
      if (!model) return;
      // Monaco's markers stay where they were set; move them to the lines the
      // note decorations tracked through the edit, so F8 and hovers stay true.
      const groups = groupsRef.current;
      const ranges = notesRef.current?.getRanges() ?? [];
      if (groups.length > 0 && ranges.length === groups.length)
        setMarkers(
          model,
          groups.map((g, i) => ({ ...g, line: ranges[i]?.startLineNumber ?? g.line })),
        );
      if (applyingParent.current) return;
      const text = model.getValue();
      syncedRef.current = text;
      callbacks.current.onChange(text);
    });
    const cursor = editor.onDidChangeCursorPosition(({ position }) => {
      if (position.lineNumber === lastLineRef.current) return;
      lastLineRef.current = position.lineNumber;
      callbacks.current.onCursorLine?.(position.lineNumber);
    });
    // Monaco measures glyph widths once; measure again when the self-hosted mono font has arrived.
    let live = true;
    void document.fonts
      .load(`${monoFont().fontSize}px ${monoFont().fontFamily}`)
      .then(() => live && monaco.remeasureFonts())
      .catch(() => {});

    return () => {
      live = false;
      content.dispose();
      cursor.dispose();
      editor.dispose();
      stopTheme();
      editorRef.current = notesRef.current = revealRef.current = null;
    };
  }, []);

  // Diagnostics: a marker (F8 walks them, the hover reads them), a dot in the
  // glyph margin and a tinted line, all following their line through edits.
  const showNotes = useCallback((notes: EditorDiagnostic[] | undefined) => {
    const editor = editorRef.current;
    const model = editor?.getModel();
    if (!editor || !model) return;
    const groups = groupDiagnostics(notes ?? [], model.getLineCount());
    groupsRef.current = groups;
    setMarkers(model, groups);
    notesRef.current?.set(
      groups.map((g) => ({
        range: new Range(g.line, 1, g.line, model.getLineMaxColumn(g.line)),
        options: {
          isWholeLine: true,
          className: `dw-note-line dw-note-line-${g.severity}`,
          glyphMarginClassName: `dw-note-marker dw-note-${g.severity}`,
          // Monaco renders this as Markdown; the message may quote the document.
          glyphMarginHoverMessage: {
            value: g.messages.map(escapeMarkdown).join("\n\n"),
            isTrusted: false,
            supportHtml: false,
          },
          stickiness: monaco.TrackedRangeStickiness.AlwaysGrowsWhenTypingAtEdges,
        },
      })),
    );
    const status = statusRef.current;
    const announcement = announceDiagnostics(groups);
    if (status && status.textContent !== announcement) status.textContent = announcement;
  }, []);

  // A different document replaces the text with setValue, which also clears
  // the undo stack: undoing into the previous document would hand its text
  // to this one. The notes the shell already sent for it are put back; setValue
  // collapsed the decorations that tracked the old text.
  useEffect(() => {
    const model = editorRef.current?.getModel();
    if (!model || documentId === documentRef.current) return;
    documentRef.current = documentId;
    syncedRef.current = value;
    applyingParent.current = true;
    try {
      model.setValue(value);
    } finally {
      applyingParent.current = false;
    }
    showNotes(diagnosticsRef.current);
  }, [documentId, value, showNotes]);

  // Apply the parent's value only when it differs from the document.
  useEffect(() => {
    const editor = editorRef.current;
    const model = editor?.getModel();
    if (!editor || !model || value === syncedRef.current) return;
    syncedRef.current = value;
    const change = minimalChange(model.getValue(), value);
    if (!change) return;
    const start = model.getPositionAt(change.from);
    const end = model.getPositionAt(change.to);
    const range = new Range(start.lineNumber, start.column, end.lineNumber, end.column);
    applyingParent.current = true;
    try {
      editor.executeEdits("docwalk-parent", [{ range, text: change.insert }]);
    } finally {
      applyingParent.current = false;
    }
  }, [value]);

  useEffect(() => {
    editorRef.current?.updateOptions({ ariaLabel: label });
  }, [label]);

  useEffect(() => showNotes(diagnostics), [diagnostics, showNotes]);

  // The fade timer lives in a ref, not in the effect's cleanup: a parent that
  // resets revealLine to null right after a reveal must not cancel the fade.
  const flashTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(flashTimer.current), []);
  useEffect(() => {
    const editor = editorRef.current;
    const model = editor?.getModel();
    if (!editor || !model || revealLine == null) return;
    const line = clampLine(revealLine, model.getLineCount());
    if (line === null) return;
    editor.revealLineInCenter(line, monaco.ScrollType.Immediate);
    revealRef.current?.set([
      {
        range: new Range(line, 1, line, 1),
        options: { isWholeLine: true, className: "dw-reveal" },
      },
    ]);
    clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => revealRef.current?.clear(), REVEAL_MS);
  }, [revealLine]);

  return (
    <div className="docwalk-editor docwalk-monaco">
      <div ref={hostRef} className="docwalk-editor-host" />
      {/* Filled by the diagnostics effect, so an unchanged text is not re-announced. */}
      <div ref={statusRef} role="status" className="dw-visually-hidden" />
    </div>
  );
}
