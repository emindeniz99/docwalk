/**
 * Contract for the source editor (decision 4). The shell renders
 * `<SourceEditor />` from ./SourceEditor.tsx; CodeMirror 6 implements it
 * today, and Monaco could later without the shell changing.
 */

export interface EditorDiagnostic {
  /** 1-based source line the note points at. */
  line: number;
  message: string;
  severity: "info" | "warning";
}

export interface SourceEditorProps {
  /** Markdown text. The editor is controlled: it reports edits and accepts replacements. */
  value: string;
  onChange: (value: string) => void;
  /** Reports the 1-based line of the cursor, so the preview can follow it. */
  onCursorLine?: (line: number) => void;
  /**
   * The 1-based line the cursor starts on when the editor mounts, scrolled
   * into the middle of the pane and clamped into the document. It is not
   * reported through `onCursorLine` (the shell passed it in) and later
   * changes are ignored: from then on the cursor belongs to the editor.
   */
  initialLine?: number | null;
  /** Lines to scroll into view and highlight briefly, e.g. when the outline is clicked. */
  revealLine?: number | null;
  diagnostics?: EditorDiagnostic[];
  /** Accessible label for the editing surface. */
  label: string;
  /**
   * Changes when `value` is a different document, never on an edit: the
   * editor then starts with a fresh undo history, so undo cannot bring back
   * the previous document's text. A change of `value` alone (an agent's
   * write) stays undoable.
   */
  documentId?: number;
}
