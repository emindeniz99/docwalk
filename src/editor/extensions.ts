import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { search, searchKeymap } from "@codemirror/search";
import {
  Annotation,
  type EditorState,
  type Extension,
  MapMode,
  RangeSet,
  StateEffect,
  StateField,
} from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  GutterMarker,
  WidgetType,
  gutter,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import type { LineNotes } from "./sync";

/** Marks a transaction that applies the parent's value, so it is not echoed back as an edit. */
export const fromParent = Annotation.define<boolean>();

/* ---- Syntax highlighting ------------------------------------------------ */

/**
 * Markdown highlighting as classes, not inline colours: editor.css maps each
 * class onto the theme-aware variables, so light and dark follow the app.
 */
const markdownHighlight = HighlightStyle.define([
  { tag: t.heading, class: "dw-tok-heading" },
  { tag: t.strong, class: "dw-tok-strong" },
  { tag: t.emphasis, class: "dw-tok-emphasis" },
  { tag: t.strikethrough, class: "dw-tok-strike" },
  { tag: [t.link, t.url], class: "dw-tok-link" },
  { tag: t.monospace, class: "dw-tok-code" },
  { tag: t.quote, class: "dw-tok-quote" },
  { tag: [t.processingInstruction, t.contentSeparator, t.labelName], class: "dw-tok-mark" },
  { tag: t.comment, class: "dw-tok-mark" },
]);

/* ---- Diagnostics: line class, gutter marker, screen-reader text --------- */

export const setDiagnostics = StateEffect.define<readonly LineNotes[]>();

class NoteMarker extends GutterMarker {
  constructor(readonly notes: LineNotes) {
    super();
  }
  // GutterMarker defaults to TrackBefore, which deletes the marker when the
  // newline before its line is deleted. A note must never vanish silently, so
  // it moves to wherever its position maps instead.
  override mapMode = MapMode.Simple;
  override eq(other: NoteMarker) {
    return other.notes === this.notes;
  }
  override toDOM() {
    const el = document.createElement("span");
    el.className = `dw-note-marker dw-note-${this.notes.severity}`;
    el.title = this.notes.messages.join("\n");
    return el;
  }
}

/**
 * The message as text inside the line, visually hidden. A screen reader
 * reads it with the line, which a gutter cannot offer: CodeMirror hides its
 * gutters from assistive technology.
 */
class NoteText extends WidgetType {
  constructor(readonly notes: LineNotes) {
    super();
  }
  override eq(other: NoteText) {
    return other.notes === this.notes;
  }
  override toDOM() {
    const el = document.createElement("span");
    el.className = "dw-visually-hidden dw-note-text";
    const kind = this.notes.severity === "warning" ? "Warning" : "Note";
    el.textContent = ` (${kind}: ${this.notes.messages.join("; ")})`;
    return el;
  }
  override ignoreEvent() {
    return true;
  }
}

interface NoteState {
  lines: DecorationSet;
  markers: RangeSet<NoteMarker>;
}

/**
 * Puts every marker, its line class and its screen-reader text on the start
 * of the line its position falls in now. After an edit a mapped position can
 * land mid-line (a join), and CodeMirror only draws gutter markers and line
 * decorations that sit exactly at a line start, so the note would vanish.
 */
function anchorNotes(state: EditorState, placed: RangeSet<NoteMarker>): NoteState {
  const markers = [];
  const lines = [];
  for (const it = placed.iter(); it.value; it.next()) {
    const { notes } = it.value;
    const line = state.doc.lineAt(it.from);
    const severity = `dw-note-line dw-note-line-${notes.severity}`;
    markers.push(it.value.range(line.from));
    lines.push(Decoration.line({ class: severity }).range(line.from));
    lines.push(Decoration.widget({ widget: new NoteText(notes), side: 1 }).range(line.to));
  }
  return { lines: Decoration.set(lines, true), markers: RangeSet.of(markers, true) };
}

function buildNotes(state: EditorState, groups: readonly LineNotes[]): NoteState {
  const markers = groups.map((notes) =>
    new NoteMarker(notes).range(state.doc.line(notes.line).from),
  );
  return anchorNotes(state, RangeSet.of(markers, true));
}

const notesField = StateField.define<NoteState>({
  create: () => ({ lines: Decoration.none, markers: RangeSet.empty }),
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setDiagnostics)) return buildNotes(tr.state, e.value);
    if (!tr.docChanged) return value;
    // Keep notes on their lines while the text changes under them.
    return anchorNotes(tr.state, value.markers.map(tr.changes));
  },
  provide: (f) => EditorView.decorations.from(f, (v) => v.lines),
});

const notesGutter = gutter({
  class: "dw-note-gutter",
  markers: (view) => view.state.field(notesField).markers,
});

/* ---- Reveal: a brief highlight on the line the outline pointed at ------- */

/** A 1-based line to highlight, or null to clear the highlight. */
export const flashLine = StateEffect.define<number | null>();

const flashField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    for (const e of tr.effects)
      if (e.is(flashLine)) {
        if (e.value === null) return Decoration.none;
        const from = tr.state.doc.line(e.value).from;
        return Decoration.set([Decoration.line({ class: "dw-reveal" }).range(from)]);
      }
    return value.map(tr.changes);
  },
  provide: (f) => EditorView.decorations.from(f),
});

/* ---- The whole setup ------------------------------------------------------ */

export interface SetupOptions {
  label: Extension;
  onUpdate: Extension;
}

/**
 * Everything the source editor needs, and nothing more: no language-data
 * bundle (fenced code stays plain), no drawSelection (native selection works
 * best on touch screens), no Tab binding (Tab keeps moving focus, so the
 * editor is never a keyboard trap).
 */
export function editorExtensions({ label, onUpdate }: SetupOptions): Extension[] {
  return [
    lineNumbers(),
    notesGutter,
    highlightActiveLineGutter(),
    highlightActiveLine(),
    history(),
    EditorView.lineWrapping,
    markdown({ base: markdownLanguage }),
    syntaxHighlighting(markdownHighlight),
    search({ top: true }),
    keymap.of([...searchKeymap, ...historyKeymap, ...defaultKeymap]),
    notesField,
    flashField,
    EditorView.contentAttributes.of({ spellcheck: "false" }),
    label,
    onUpdate,
  ];
}
