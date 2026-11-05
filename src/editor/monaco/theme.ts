import type { editor } from "monaco-editor/editor";

/**
 * Monaco's colours, read from the app's semantic CSS variables (styles.css
 * maps them onto the design tokens per theme). Monaco cannot take CSS
 * variables, only hex strings, so the theme is rebuilt from the computed
 * values whenever light/dark changes; there is no second copy of the palette
 * to drift from DESIGN.md.
 */
export interface Palette {
  dark: boolean;
  bg: string;
  surface: string;
  border: string;
  borderStrong: string;
  fg: string;
  muted: string;
  link: string;
  focus: string;
  noteBg: string;
  noteBorder: string;
}

const VARS = {
  bg: "--bg",
  surface: "--surface",
  border: "--border",
  borderStrong: "--border-strong",
  fg: "--fg",
  muted: "--muted",
  link: "--link",
  focus: "--focus",
  noteBg: "--note-bg",
  noteBorder: "--note-border",
} as const;

const HEX = /^#[\da-f]{6}$/i;

/** The palette in force on `root` now; a variable that is not a 6-digit hex comes back empty. */
export function readPalette(root: HTMLElement = document.documentElement): Palette {
  const style = getComputedStyle(root);
  const read = (name: string) => {
    const value = style.getPropertyValue(name).trim();
    return HEX.test(value) ? value.toLowerCase() : "";
  };
  const entries = Object.entries(VARS).map(([key, name]) => [key, read(name)]);
  return {
    ...(Object.fromEntries(entries) as Omit<Palette, "dark">),
    dark: style.colorScheme.includes("dark"),
  };
}

/** `#rrggbb` plus an alpha byte, for Monaco's translucent selection and scrollbar colours. */
const alpha = (hex: string, byte: string) => (hex ? `${hex}${byte}` : "");

/** A token rule's foreground: Monaco wants the hex without `#`; a missing colour inherits. */
const fg = (hex: string) => (hex ? { foreground: hex.slice(1) } : {});

/**
 * Markdown highlighting kept as plain as the CodeMirror editor's
 * (editor.css): headings and markers in weight, links and code in the link
 * colour, quotes and HTML muted. Diagnostics are yellow, never red
 * (DESIGN.md `note-*`), whatever severity Monaco gives them.
 */
export function monacoTheme(p: Palette): editor.IStandaloneThemeData {
  const colors: Record<string, string> = {
    "editor.background": p.surface,
    "editor.foreground": p.fg,
    "editorGutter.background": p.surface,
    "editorLineNumber.foreground": p.muted,
    "editorLineNumber.activeForeground": p.fg,
    "editor.lineHighlightBackground": p.bg,
    "editor.lineHighlightBorder": p.bg,
    "editorCursor.foreground": p.fg,
    "editor.selectionBackground": alpha(p.focus, "40"),
    "editor.inactiveSelectionBackground": alpha(p.focus, "26"),
    "editor.findMatchBackground": p.noteBg,
    "editor.findMatchBorder": p.focus,
    "editor.findMatchHighlightBackground": p.noteBg,
    "editor.findMatchHighlightBorder": p.noteBorder,
    "editor.rangeHighlightBackground": alpha(p.focus, "1a"),
    "editorWarning.foreground": p.noteBorder,
    "editorInfo.foreground": p.noteBorder,
    "editorOverviewRuler.warningForeground": p.noteBorder,
    "editorOverviewRuler.infoForeground": p.noteBorder,
    "editorOverviewRuler.border": p.border,
    "editorIndentGuide.background1": p.border,
    "editorWidget.background": p.surface,
    "editorWidget.foreground": p.fg,
    "editorWidget.border": p.borderStrong,
    "editorHoverWidget.background": p.surface,
    "editorHoverWidget.border": p.borderStrong,
    "editorMarkerNavigation.background": p.surface,
    "editorMarkerNavigationWarning.background": p.noteBorder,
    "editorMarkerNavigationInfo.background": p.noteBorder,
    "input.background": p.surface,
    "input.foreground": p.fg,
    "input.border": p.borderStrong,
    "inputOption.activeBorder": p.focus,
    focusBorder: p.focus,
    "scrollbarSlider.background": alpha(p.muted, "33"),
    "scrollbarSlider.hoverBackground": alpha(p.muted, "55"),
    "scrollbarSlider.activeBackground": alpha(p.muted, "77"),
  };
  return {
    base: p.dark ? "vs-dark" : "vs",
    inherit: true,
    rules: [
      { token: "", ...fg(p.fg) },
      { token: "keyword", ...fg(p.fg), fontStyle: "bold" },
      { token: "strong", fontStyle: "bold" },
      { token: "emphasis", fontStyle: "italic" },
      { token: "string", ...fg(p.link) },
      { token: "string.link", ...fg(p.link) },
      { token: "variable", ...fg(p.link) },
      { token: "variable.source", ...fg(p.link) },
      { token: "comment", ...fg(p.muted), fontStyle: "italic" },
      { token: "meta.separator", ...fg(p.muted) },
      { token: "tag", ...fg(p.muted) },
      { token: "delimiter.html", ...fg(p.muted) },
      { token: "attribute.name.html", ...fg(p.muted) },
      { token: "string.html", ...fg(p.link) },
      { token: "string.escape", ...fg(p.muted) },
    ],
    // An empty value means the variable was missing; Monaco's base theme fills that key in.
    colors: Object.fromEntries(Object.entries(colors).filter(([, v]) => v !== "")),
  };
}
