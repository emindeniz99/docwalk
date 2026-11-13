import { useCallback, useState, type ComponentType } from "react";
import type { SourceEditorProps } from "./types";

/**
 * The editor in the Edit view. A switch of editor mounts the other one on the
 * line where this document's cursor last was (decision 102). The line lives
 * here rather than in App, so a cursor move re-renders the editor only; this
 * slot unmounts with the Edit view, so coming back starts on line 1.
 */
export function EditorSlot({
  Editor,
  onCursorLine,
  ...props
}: Omit<SourceEditorProps, "initialLine"> & { Editor: ComponentType<SourceEditorProps> }) {
  const [cursor, setCursor] = useState<{ line: number; doc: number | undefined } | null>(null);
  const { documentId } = props;
  const report = useCallback(
    (line: number) => {
      setCursor({ line, doc: documentId });
      onCursorLine?.(line);
    },
    [documentId, onCursorLine],
  );
  return (
    <Editor
      {...props}
      onCursorLine={report}
      initialLine={cursor && cursor.doc === documentId ? cursor.line : null}
    />
  );
}
