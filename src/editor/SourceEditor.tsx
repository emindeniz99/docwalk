import type { SourceEditorProps } from "./types";

/**
 * Placeholder implementation of the editor contract: a plain textarea.
 * CodeMirror 6 replaces it behind the same props (decision 4).
 */
export function SourceEditor({ value, onChange, onCursorLine, label }: SourceEditorProps) {
  return (
    <textarea
      className="docwalk-source-textarea"
      aria-label={label}
      value={value}
      spellCheck={false}
      onChange={(e) => onChange(e.target.value)}
      onSelect={(e) => {
        const el = e.currentTarget;
        onCursorLine?.(el.value.slice(0, el.selectionStart).split("\n").length);
      }}
    />
  );
}
