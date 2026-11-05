import { Compartment, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import "./editor.css";
import { editorExtensions, flashLine, fromParent, setDiagnostics } from "./extensions";
import { announceDiagnostics, clampLine, groupDiagnostics, minimalChange } from "./sync";
import type { SourceEditorProps } from "./types";

/** How long a revealed line stays highlighted. */
const REVEAL_MS = 1200;

const labelAttrs = (label: string) => EditorView.contentAttributes.of({ "aria-label": label });

/**
 * The Markdown source editor (decision 4): CodeMirror 6 behind the
 * SourceEditorProps contract. Controlled, but an echo of the editor's own
 * text is a no-op, so typing never loses the cursor or the undo history.
 */
export function SourceEditor({
  value,
  onChange,
  onCursorLine,
  revealLine,
  diagnostics,
  label,
}: SourceEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const statusRef = useRef<HTMLDivElement>(null);
  const [labelCompartment] = useState(() => new Compartment());
  // The text the editor and the parent last agreed on; an echo of it is skipped
  // by an O(1) string comparison instead of serialising the document.
  const syncedRef = useRef(value);
  const lastLineRef = useRef<number | null>(null);
  const callbacks = useRef({ onChange, onCursorLine });
  useLayoutEffect(() => {
    callbacks.current = { onChange, onCursorLine };
  });
  const initial = useRef({ value, label });

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const onUpdate = EditorView.updateListener.of((update) => {
      if (update.docChanged && !update.transactions.some((tr) => tr.annotation(fromParent))) {
        const text = update.state.doc.toString();
        syncedRef.current = text;
        callbacks.current.onChange(text);
      }
      if (update.docChanged || update.selectionSet) {
        const line = update.state.doc.lineAt(update.state.selection.main.head).number;
        if (line !== lastLineRef.current) {
          lastLineRef.current = line;
          callbacks.current.onCursorLine?.(line);
        }
      }
    });
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: initial.current.value,
        extensions: editorExtensions({
          label: labelCompartment.of(labelAttrs(initial.current.label)),
          onUpdate,
        }),
      }),
    });
    syncedRef.current = initial.current.value;
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [labelCompartment]);

  // Apply the parent's value only when it differs from the document.
  useEffect(() => {
    const view = viewRef.current;
    if (!view || value === syncedRef.current) return;
    syncedRef.current = value;
    const change = minimalChange(view.state.doc.toString(), value);
    if (change) view.dispatch({ changes: change, annotations: fromParent.of(true) });
  }, [value]);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: labelCompartment.reconfigure(labelAttrs(label)) });
  }, [label, labelCompartment]);

  // Diagnostics are rebuilt only when the parent sends new ones; between
  // updates they follow their lines through edits instead of jumping back.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const groups = groupDiagnostics(diagnostics ?? [], view.state.doc.lines);
    view.dispatch({ effects: setDiagnostics.of(groups) });
    // Rewriting the same text can make a screen reader repeat it, so only a
    // different announcement touches the live region.
    const status = statusRef.current;
    const announcement = announceDiagnostics(groups);
    if (status && status.textContent !== announcement) status.textContent = announcement;
  }, [diagnostics]);

  // The fade timer lives in a ref, not in the effect's cleanup: a parent that
  // resets revealLine to null right after a reveal must not cancel the fade.
  const flashTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(flashTimer.current), []);
  useEffect(() => {
    const view = viewRef.current;
    if (!view || revealLine == null) return;
    const line = clampLine(revealLine, view.state.doc.lines);
    if (line === null) return;
    const pos = view.state.doc.line(line).from;
    view.dispatch({
      effects: [EditorView.scrollIntoView(pos, { y: "center" }), flashLine.of(line)],
    });
    clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(
      () => viewRef.current?.dispatch({ effects: flashLine.of(null) }),
      REVEAL_MS,
    );
  }, [revealLine]);

  return (
    <div className="docwalk-editor">
      <div ref={hostRef} className="docwalk-editor-host" />
      {/* Filled by the diagnostics effect, so an unchanged text is not re-announced. */}
      <div ref={statusRef} role="status" className="dw-visually-hidden" />
    </div>
  );
}
