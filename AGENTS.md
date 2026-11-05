# Agent instructions: docwalk

Read these in order before any non-trivial work:

1. [`MEMORY.md`](./MEMORY.md): current state and what the last session
   learned.
2. [`docs/decisions.md`](./docs/decisions.md): the settled decisions. Change
   the decision (and add an ADR under `docs/adr/` when you reverse one)
   before changing the code it describes.
3. This file: the project rules.

Naming goes through [`CONTEXT.md`](./CONTEXT.md). The roadmap and the spike
plan are in [`ROADMAP.md`](./ROADMAP.md).

## Project rules

1. **The Markdown file is the API.** docwalk never requires syntax GitHub
   would not render, and never writes to the source to make it fit.
   Viewer state (level override, theme, annotations) lives in the URL or
   the browser, never in the document.
2. **Split on the AST, never with a regex.** A `---` under a paragraph is a
   setext heading; a `---` inside a fence is text. Every sectioning and
   pagination step works on the parsed tree or on the rendered DOM.
3. **Overflow is reported or split, never hidden.** No global shrink, no
   silent clipping. Code blocks, diagrams and images stay whole; one taller
   than an empty slide gets a visible diagnostic.
4. **Measure only after everything has rendered:** `document.fonts.ready`,
   then `mermaid.run()`, then image decode, then one animation frame.
   Measure each Mermaid host on its own as well as the slide, because
   diagram hosts hide their own overflow.
5. **Every input is hostile.** Markdown goes through rehype-sanitize with
   the GitHub schema and then DOMPurify. Mermaid runs in `strict` mode after
   a pre-pass that strips `%%{init}%%` overrides, image shapes and CSS
   `url()`; `bindFunctions` is never called and its SVG goes through
   DOMPurify. Remote images load only through the sanitizer's
   click-to-load rewrite or the "always load" setting. Tokens live in
   `sessionStorage`, never `localStorage`, never in logs.
6. **The static build must work on its own.** Anything that needs `/api`
   (OAuth, remote control) is feature-detected and hidden when the Worker is
   absent. CI builds and tests the static output.
7. **Slides are addressed by section, not by index.** Measured pagination
   depends on viewport and fonts, so links use `<section-id>/<n>`.
8. **No analytics, no telemetry, no outbound calls the user did not ask
   for.** A change that adds one needs a decision first.
9. **Tests state why.** Layout and pagination tests run in a real browser
   (Vitest Browser Mode or Playwright), never jsdom. Property tests guard
   the pagination invariants: no content lost, none duplicated, every slide
   fits or carries a diagnostic.
10. **Dependencies:** newest versions at least 7 days old (the repo's pnpm
    `minimumReleaseAge`). No personal data anywhere in this project,
    fixtures included.
11. Commit scope is `docwalk` (`feat(docwalk): …`), English everywhere.
