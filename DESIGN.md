---
version: alpha
name: docwalk
description: Presentation-first look for walking a team through a GitHub Markdown design doc. A white slide on a dark stage, a light editor with a command palette and status bar, GitHub-like reading in document mode. Tokens mirror src/design/tokens.ts; a test keeps the two equal.
colors:
  canvas: "#f4f4f2"
  surface: "#ffffff"
  border: "#e3e3df"
  border-strong: "#d6d6d1"
  ink: "#17181c"
  ink-muted: "#5c5e66"
  primary: "#e5532d"
  on-primary: "#1a0702"
  primary-ink: "#b8381a"
  focus: "#2457d6"
  note-surface: "#fff4d6"
  note-border: "#e0b54a"
  note-ink: "#6b4400"
  stage: "#15171c"
  stage-raised: "#22252d"
  stage-border: "#3a3d47"
  stage-ink: "#e9eaee"
  stage-muted: "#b9bcc6"
  stage-note-surface: "#2a2412"
  stage-note-border: "#5a4a16"
  stage-note-ink: "#fde9a8"
  slide: "#ffffff"
  slide-ink: "#17181c"
  slide-muted: "#5c5e66"
  slide-shadow: "rgba(0, 0, 0, 0.35)"
  canvas-dark: "#0f1115"
  surface-dark: "#17191f"
  border-dark: "#2c2f38"
  ink-dark: "#eceef2"
  ink-muted-dark: "#a1a5b0"
  primary-ink-dark: "#ff8a6b"
  focus-dark: "#7aa2ff"
  note-surface-dark: "#2a2412"
  note-ink-dark: "#fde9a8"
  alert-note: "#0969da"
  alert-tip: "#1a7f37"
  alert-important: "#8250df"
  alert-warning: "#9a6700"
  alert-caution: "#d1242f"
  alert-note-dark: "#4493f8"
  alert-tip-dark: "#3fb950"
  alert-important-dark: "#ab7df8"
  alert-warning-dark: "#d29922"
  alert-caution-dark: "#f85149"
  code-keyword: "#cf222e"
  code-string: "#0a3069"
  code-comment: "#57606a"
  code-constant: "#0550ae"
  code-function: "#6639ba"
  code-parameter: "#953800"
  code-inserted: "#116329"
  code-inserted-surface: "#dafbe1"
  code-deleted: "#82071e"
  code-deleted-surface: "#ffebe9"
  code-keyword-dark: "#ff7b72"
  code-string-dark: "#a5d6ff"
  code-comment-dark: "#8b949e"
  code-constant-dark: "#79c0ff"
  code-function-dark: "#d2a8ff"
  code-parameter-dark: "#ffa657"
  code-inserted-dark: "#aff5b4"
  code-inserted-surface-dark: "#033a16"
  code-deleted-dark: "#ffdcd7"
  code-deleted-surface-dark: "#67060c"
typography:
  slide-title:
    fontFamily: Bricolage Grotesque Variable
    fontSize: 56px
    fontWeight: 800
    lineHeight: 1.05
    letterSpacing: -0.02em
  slide-body:
    fontFamily: Inter Variable
    fontSize: 26px
    fontWeight: 400
    lineHeight: 1.5
  heading:
    fontFamily: Bricolage Grotesque Variable
    fontSize: 22px
    fontWeight: 800
    lineHeight: 1.2
    letterSpacing: -0.02em
  body:
    fontFamily: Inter Variable
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.55
  ui:
    fontFamily: Inter Variable
    fontSize: 14px
    fontWeight: 500
    lineHeight: 1.4
  caption:
    fontFamily: Inter Variable
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.4
  overline:
    fontFamily: Inter Variable
    fontSize: 11px
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: 0.08em
  mono:
    fontFamily: JetBrains Mono Variable
    fontSize: 13px
    fontWeight: 400
    lineHeight: 1.7
rounded:
  sm: 4px
  md: 8px
  lg: 10px
  xl: 14px
  full: 999px
spacing:
  xs: 4px
  sm: 8px
  md: 12px
  lg: 16px
  xl: 24px
  2xl: 32px
  3xl: 48px
  control: 38px
  target: 44px
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    typography: "{typography.ui}"
    rounded: "{rounded.md}"
    height: 38px
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    typography: "{typography.ui}"
    rounded: "{rounded.md}"
    height: 38px
  slide:
    backgroundColor: "{colors.slide}"
    textColor: "{colors.slide-ink}"
    rounded: "{rounded.lg}"
  slide-shadow:
    backgroundColor: "{colors.slide-shadow}"
    size: 48px
  stage:
    backgroundColor: "{colors.stage}"
    textColor: "{colors.stage-ink}"
  note:
    backgroundColor: "{colors.note-surface}"
    textColor: "{colors.note-ink}"
    rounded: "{rounded.md}"
  link:
    textColor: "{colors.primary-ink}"
  link-dark:
    textColor: "{colors.primary-ink-dark}"
  app:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
  app-dark:
    backgroundColor: "{colors.canvas-dark}"
    textColor: "{colors.ink-dark}"
  panel-dark:
    backgroundColor: "{colors.surface-dark}"
    textColor: "{colors.ink-dark}"
  caption-text:
    textColor: "{colors.ink-muted}"
    typography: "{typography.caption}"
  caption-text-dark:
    textColor: "{colors.ink-muted-dark}"
    typography: "{typography.caption}"
  divider:
    backgroundColor: "{colors.border}"
    height: 1px
  divider-strong:
    backgroundColor: "{colors.border-strong}"
    height: 1px
  divider-dark:
    backgroundColor: "{colors.border-dark}"
    height: 1px
  focus-ring:
    backgroundColor: "{colors.focus}"
    size: 2px
  focus-ring-dark:
    backgroundColor: "{colors.focus-dark}"
    size: 2px
  outline-note-dot:
    backgroundColor: "{colors.note-border}"
    size: 8px
  note-dark:
    backgroundColor: "{colors.note-surface-dark}"
    textColor: "{colors.note-ink-dark}"
    rounded: "{rounded.md}"
  stage-control:
    backgroundColor: "{colors.stage-raised}"
    textColor: "{colors.stage-ink}"
    rounded: "{rounded.lg}"
    size: "{spacing.target}"
  stage-divider:
    backgroundColor: "{colors.stage-border}"
    height: 1px
  stage-caption:
    textColor: "{colors.stage-muted}"
    typography: "{typography.caption}"
  stage-note:
    backgroundColor: "{colors.stage-note-surface}"
    textColor: "{colors.stage-note-ink}"
    rounded: "{rounded.md}"
  stage-note-edge:
    backgroundColor: "{colors.stage-note-border}"
    height: 1px
  slide-continued:
    textColor: "{colors.slide-muted}"
    typography: "{typography.slide-body}"
  alert-note-title:
    backgroundColor: "{colors.slide}"
    textColor: "{colors.alert-note}"
  alert-tip-title:
    backgroundColor: "{colors.slide}"
    textColor: "{colors.alert-tip}"
  alert-important-title:
    backgroundColor: "{colors.slide}"
    textColor: "{colors.alert-important}"
  alert-warning-title:
    backgroundColor: "{colors.slide}"
    textColor: "{colors.alert-warning}"
  alert-caution-title:
    backgroundColor: "{colors.slide}"
    textColor: "{colors.alert-caution}"
  alert-note-title-dark:
    backgroundColor: "{colors.surface-dark}"
    textColor: "{colors.alert-note-dark}"
  alert-tip-title-dark:
    backgroundColor: "{colors.surface-dark}"
    textColor: "{colors.alert-tip-dark}"
  alert-important-title-dark:
    backgroundColor: "{colors.surface-dark}"
    textColor: "{colors.alert-important-dark}"
  alert-warning-title-dark:
    backgroundColor: "{colors.surface-dark}"
    textColor: "{colors.alert-warning-dark}"
  alert-caution-title-dark:
    backgroundColor: "{colors.surface-dark}"
    textColor: "{colors.alert-caution-dark}"
  code-keyword:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.code-keyword}"
  code-string:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.code-string}"
  code-comment:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.code-comment}"
  code-constant:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.code-constant}"
  code-function:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.code-function}"
  code-parameter:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.code-parameter}"
  code-inserted:
    backgroundColor: "{colors.code-inserted-surface}"
    textColor: "{colors.code-inserted}"
  code-deleted:
    backgroundColor: "{colors.code-deleted-surface}"
    textColor: "{colors.code-deleted}"
  code-keyword-dark:
    backgroundColor: "{colors.canvas-dark}"
    textColor: "{colors.code-keyword-dark}"
  code-string-dark:
    backgroundColor: "{colors.canvas-dark}"
    textColor: "{colors.code-string-dark}"
  code-comment-dark:
    backgroundColor: "{colors.canvas-dark}"
    textColor: "{colors.code-comment-dark}"
  code-constant-dark:
    backgroundColor: "{colors.canvas-dark}"
    textColor: "{colors.code-constant-dark}"
  code-function-dark:
    backgroundColor: "{colors.canvas-dark}"
    textColor: "{colors.code-function-dark}"
  code-parameter-dark:
    backgroundColor: "{colors.canvas-dark}"
    textColor: "{colors.code-parameter-dark}"
  code-inserted-dark:
    backgroundColor: "{colors.code-inserted-surface-dark}"
    textColor: "{colors.code-inserted-dark}"
  code-deleted-dark:
    backgroundColor: "{colors.code-deleted-surface-dark}"
    textColor: "{colors.code-deleted-dark}"
---

# docwalk design

## Overview

docwalk is a presentation tool for documents that already exist. The design
has two jobs that pull in different directions: let a presenter walk a room
through a dense technical document, and let an author fix that document fast.
So it has two moods. Presenting is a stage: a white slide on a dark ground,
big type, chrome that stays out of the way. Editing is a workbench: light,
calm, an outline with page counts and notes, a command palette (⌘K) and a
status bar that says what docwalk did to the document and what it did not
upload. Document mode reads like GitHub, because that is where the document
lives.

Two rules sit above every surface. The content on a slide is the document's
own: docwalk never rewrites a heading or turns a table into something else.
And nothing is hidden silently: when docwalk splits, shrinks or flags
content, the UI says so.

## Colors

The palette is neutral warm greys with one accent, vermilion
(`primary`, `#e5532d`). The accent marks the primary action, the current position and
the pen. It is never the only cue: a selected item also changes weight or
gains a border, so colour-blind readers see the state too.

- `primary` fills buttons with `on-primary` text (5.2:1). Text links on light
  surfaces use the darker `primary-ink` (5.8:1 on white, 5.3:1 on `canvas`);
  on dark surfaces, `primary-ink-dark` (7.6:1).
- `stage` is the ground around a slide in the preview and when presenting
  in the card frame. It is dark in both themes so the slide reads as the
  brightest thing in the room, like a projector screen. In the fill frame,
  the presenting default (decision 77), the slide covers the screen and the
  room a screen that is not 16:9 leaves around it takes `slide`, so it reads
  as more page, not as bars; `stage` stays only under the presenting bar.
- `slide` stays white in both themes. A slide is a document page, and
  presenters expect the projected page to look the same on every laptop.
- `note-*` colours carry diagnostics: content that was split, scaled down
  or is too tall. They are yellow, not red: a note is information, not an
  error.
- `focus` is a blue ring, distinct from the accent, so keyboard focus never
  looks like selection.
- `alert-*` colours are GitHub's own for `> [!NOTE]`, `[!TIP]`,
  `[!IMPORTANT]`, `[!WARNING]` and `[!CAUTION]`: a 4px left edge and a
  coloured title with its octicon, so an alert looks the same here as on
  GitHub. Slides always use the light set (the slide is white); document
  mode switches to the `-dark` set with the theme. Every title passes 4.5:1
  on its surface (lowest: `alert-warning` on white, 4.9:1; computed
  2026-11-05).
- `code-*` colours are GitHub's own syntax colours for fenced code blocks
  (decision 76): keyword, string, comment, constant, function and parameter,
  plus added and removed lines in a diff, each on its own tinted surface.
  Like alerts, slides always use the light set on the `canvas` block and
  document mode switches to the `-dark` set on `canvas-dark`. Colour only:
  no bold or italic, so a highlighted block keeps the metrics pagination
  measured. A diff line keeps its `+` or `-`, so colour is not the only cue.
  Every token passes 4.5:1 on its surface (lowest: `code-keyword` on
  `canvas`, 4.9:1; `src/design/contrast.test.ts` computes them).
- Every text pair passes WCAG 2.2 AA: 4.5:1 for body text, 3:1 for text
  24px and larger. The lowest pair in the file is `primary` on `stage`
  (4.8:1), used only for the progress bar, not text. Ratios were computed
  from the hex values on 2026-11-05.

## Typography

- **Bricolage Grotesque** (variable, OFL) sets slide titles and app
  headings. It has the presence a slide title needs from across a room
  without the coldness of a neo-grotesque.
- **Inter** (variable, OFL) sets everything else: slide body, UI, captions.
  Tabular figures in counters (`22 / 47`).
- **JetBrains Mono** (variable, OFL) sets the editor and code blocks.

Fonts are self-hosted from the build (`@fontsource-variable/*`). Loading
them from a font CDN would send every visitor's IP address to a third
party, which breaks the promise that a pasted document never leaves the
browser.

Slide text is set for the room: titles at 56px and body at 26px on the
1280×720 slide. The UI uses 14px with 16px for reading.

## Layout

The slide is a fixed 1280×720 stage that reveal.js scales to the window, so
pagination decisions do not change with window size. Presenting, it fills
the screen up to that 16:9 fit, with the presenting bar laid over its top
while the bar hides when idle; the card frame keeps a 10% margin and gives
the bar a band of its own. The editor is three
columns: outline (250px), source, preview. At phone width they stack and the
outline becomes a sheet.

Spacing follows a 4px base (`xs` to `3xl`). Controls are `control` (38px)
high with a mouse, so header buttons, icon buttons and the annotation tools
in the edit preview share one row height. A preview too narrow for the
annotation tools at that height, such as one beside the comments panel at
1280px, sets them and the overview button at `2xl` (32px), so they keep one
row (decision 108); no control goes below 24px (WCAG 2.5.8). Interactive
targets are at least `target` (44px) high on touch screens and on the stage
while presenting.

## Elevation & Depth

The app is flat. Depth appears in exactly one place: the slide casts a soft
shadow onto the stage, because the slide is the object of attention. A
slide that fills the screen has no stage to cast it on and drops it. Dialogs
and popovers use a 1px border plus a small shadow; nothing else floats.

## Shapes

Corners are gently rounded: `md` (8px) for buttons and inputs, `lg` (10px)
for the slide in the preview and the card frame (square when it fills the
screen), `xl` (14px) when presenting full screen and on
phone controls. Pills (`full`) are only for status chips.

## Components

- **Primary button**: vermilion fill, dark text, one per surface ("Present").
- **Secondary button**: white with a `border-strong` outline.
- **Outline item**: section title plus page count; a small dot in
  `note-border` marks a section with a note. The current item gets the
  `canvas` fill and semibold weight.
- **Command palette** (⌘K): jump to any slide by title, run any command,
  change any setting.
- **Note**: yellow box with a count chip; every note links to the source line.
- **Slide**: white page, `overline` breadcrumb, `slide-title` heading,
  "· continued" in `slide-muted` on continuation pages.
- **Alert**: GitHub's `> [!NOTE]` family, unchanged from GitHub: left
  edge and title in the alert's colour, body in the normal text colour.
- **Footnotes**: on a slide, the definitions of the footnotes that slide
  references, under a thin rule in smaller `slide-muted` text; in document
  mode, one list at the end, as on GitHub.
- **Stage controls**: 44px square buttons on `stage-raised`, icon plus
  accessible label; a per-section progress bar along the bottom. While
  presenting they fade out after three idle seconds (decision 75); in the
  fill frame the bar is a `stage` strip over the top of the slide, on the
  card the slide takes its room; the first time, a `stage-raised` pill at the
  bottom of the stage says how to bring them back.
- **Slide overview** (O, or the grid button beside the slide counter): every
  page as a white thumbnail on the stage, numbered, with a `stage-note`
  "Note" chip on flagged pages. The current slide has an accent border and a
  "Current" chip. Arrow keys move, Enter jumps, Escape closes.
- **Update prompt**: a toast at the bottom end, `surface` with a
  `border-strong` edge and the popover shadow; title, one caption line, a
  primary "Reload" and a dismiss button. It never takes focus, so it cannot
  interrupt a talk.
- **App icon**: the Stage reduced to shapes, a white slide over a vermilion
  progress bar on `stage`; drawn from the tokens by `tooling/pwa.ts`.

Components come from React Aria Components, styled only with these tokens.

## Do's and Don'ts

- Do show the document's own words on every slide. Don't rewrite, summarise
  or restyle content into cards.
- Do say what docwalk changed ("split at H3 · 7 slides", "diagram at 26%").
  Don't scale content down without a note.
- Do keep the slide white and the stage dark in both themes.
- Don't use the accent as the only signal of state.
- Don't load fonts, icons or anything else from a third-party host at
  runtime.
- Don't add colours, sizes or radii outside this file and
  `src/design/tokens.ts`.
