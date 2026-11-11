import { m } from "../paraglide/messages.js";
import type { EditorDiagnostic } from "./types";

/**
 * Pure helpers for the CodeMirror source editor. They hold no CodeMirror
 * state, so the rules they encode are unit-tested in Node.
 */

interface TextChange {
  from: number;
  to: number;
  insert: string;
}

/**
 * The smallest single replacement that turns `before` into `after`, or null
 * when they are equal. Replacing only the changed middle keeps the cursor and
 * the undo history of the untouched text when the parent supplies a new value.
 */
export function minimalChange(before: string, after: string): TextChange | null {
  if (before === after) return null;
  const max = Math.min(before.length, after.length);
  let start = 0;
  while (start < max && before.charCodeAt(start) === after.charCodeAt(start)) start++;
  let end = 0;
  while (
    end < max - start &&
    before.charCodeAt(before.length - 1 - end) === after.charCodeAt(after.length - 1 - end)
  )
    end++;
  // Never cut a surrogate pair in half: a lone half is not valid text.
  if (start > 0 && isHighSurrogate(before.charCodeAt(start - 1))) start--;
  if (end > 0 && isLowSurrogate(before.charCodeAt(before.length - end))) end--;
  return { from: start, to: before.length - end, insert: after.slice(start, after.length - end) };
}

const isHighSurrogate = (c: number) => c >= 0xd800 && c <= 0xdbff;
const isLowSurrogate = (c: number) => c >= 0xdc00 && c <= 0xdfff;

/** A 1-based line clamped into the document, or null when it is not a line number at all. */
export function clampLine(line: number, lineCount: number): number | null {
  if (!Number.isFinite(line) || lineCount < 1) return null;
  return Math.min(Math.max(Math.trunc(line), 1), lineCount);
}

export interface LineNotes {
  line: number;
  severity: EditorDiagnostic["severity"];
  messages: string[];
}

/**
 * Diagnostics grouped per line, sorted by line, with the strongest severity
 * of the group. Lines past the end are clamped to the last line: diagnostics
 * lag one edit behind the text, and a note must never vanish silently.
 */
export function groupDiagnostics(diagnostics: readonly EditorDiagnostic[], lineCount: number) {
  const byLine = new Map<number, LineNotes>();
  for (const d of diagnostics) {
    const line = clampLine(d.line, lineCount);
    if (line === null) continue;
    const group = byLine.get(line);
    if (group) {
      group.messages.push(d.message);
      if (d.severity === "warning") group.severity = "warning";
    } else byLine.set(line, { line, severity: d.severity, messages: [d.message] });
  }
  return [...byLine.values()].toSorted((a, b) => a.line - b.line);
}

/** What the polite live region says when the diagnostics change; empty says nothing. */
export function announceDiagnostics(groups: readonly LineNotes[]): string {
  const count = groups.reduce((n, g) => n + g.messages.length, 0);
  if (count === 0) return "";
  const lines = groups.map((g) => g.line);
  const where =
    lines.length === 1
      ? m.editor_line({ line: lines[0] ?? 1 })
      : m.editor_lines({ list: lines.slice(0, -1).join(", "), last: lines.at(-1) ?? 1 });
  return m.editor_announce({ count, where });
}
