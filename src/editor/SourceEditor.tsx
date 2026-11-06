import { Compartment, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useLocale } from "../i18n/locale";
import { m } from "../paraglide/messages.js";
import "./editor.css";
import { editorExtensions, flashLine, fromParent, setDiagnostics } from "./extensions";
import { announceDiagnostics, clampLine, groupDiagnostics, minimalChange } from "./sync";
import type { SourceEditorProps } from "./types";

/** How long a revealed line stays highlighted. */
const REVEAL_MS = 1200;

const labelAttrs = (label: string) => EditorView.contentAttributes.of({ "aria-label": label });

/**
 * CodeMirror's own strings (the search panel, go to line, screen-reader
 * announcements) in the UI language, keyed by its English text. The
 * language is read when this runs; the editor reconfigures it on a switch.
 */
const phrases = () =>
  EditorState.phrases.of({
    Find: m.cm_find(),
    Replace: m.cm_replace(),
    next: m.cm_next(),
    previous: m.cm_previous(),
    all: m.cm_all(),
    "match case": m.cm_match_case(),
    regexp: m.cm_regexp(),
    "by word": m.cm_by_word(),
    replace: m.cm_replace_one(),
    "replace all": m.cm_replace_all(),
    close: m.cm_close(),
    "Go to line": m.cm_go_to_line(),
    go: m.cm_go(),
    "current match": m.cm_current_match(),
    "on line": m.cm_on_line(),
    "replaced $ matches": m.cm_replaced_matches(),
    "replaced match on line $": m.cm_replaced_on_line(),
    "Selection deleted": m.cm_selection_deleted(),
    "Control character": m.cm_control_character(),
  });

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
  documentId,
}: SourceEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const statusRef = useRef<HTMLDivElement>(null);
  const [labelCompartment] = useState(() => new Compartment());
  const [phraseCompartment] = useState(() => new Compartment());
  const locale = useLocale();
  // The text the editor and the parent last agreed on; an echo of it is skipped
  // by an O(1) string comparison instead of serialising the document.
  const syncedRef = useRef(value);
  const lastLineRef = useRef<number | null>(null);
  const callbacks = useRef({ onChange, onCursorLine });
  useLayoutEffect(() => {
    callbacks.current = { onChange, onCursorLine };
  });
  const initial = useRef({ value, label });
  const labelRef = useRef(label);
  const diagnosticsRef = useRef(diagnostics);
  const documentRef = useRef(documentId);
  useLayoutEffect(() => {
    labelRef.current = label;
    diagnosticsRef.current = diagnostics;
  });
  /** A whole editor state for `doc`: also how a different document gets a fresh undo history. */
  const stateFor = useRef<((doc: string) => EditorState) | null>(null);

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
    const create = (doc: string) =>
      EditorState.create({
        doc,
        extensions: [
          phraseCompartment.of(phrases()),
          editorExtensions({
            label: labelCompartment.of(labelAttrs(labelRef.current)),
            onUpdate,
          }),
        ],
      });
    stateFor.current = create;
    const view = new EditorView({ parent: host, state: create(initial.current.value) });
    syncedRef.current = initial.current.value;
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = stateFor.current = null;
    };
  }, [labelCompartment, phraseCompartment]);

  // A different document replaces the whole state, undo history included:
  // undoing into the previous document would hand its text to this one.
  useEffect(() => {
    const view = viewRef.current;
    const create = stateFor.current;
    if (!view || !create || documentId === documentRef.current) return;
    documentRef.current = documentId;
    syncedRef.current = value;
    lastLineRef.current = null;
    view.setState(create(value));
    // The new state starts without the notes; put the current ones back.
    const groups = groupDiagnostics(diagnosticsRef.current ?? [], view.state.doc.lines);
    view.dispatch({ effects: setDiagnostics.of(groups) });
  }, [documentId, value]);

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

  useEffect(() => {
    viewRef.current?.dispatch({ effects: phraseCompartment.reconfigure(phrases()) });
    // `locale` is not read here: phrases() reads the current language from Paraglide.
    // oxlint-disable-next-line react/exhaustive-effect-dependencies
  }, [locale, phraseCompartment]);

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
