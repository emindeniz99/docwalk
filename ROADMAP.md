# Roadmap: docwalk

Dated 2026-11-05. Update this file when an item ships or a deferred item's
trigger fires, and delete the entry in the same commit.

## v1

### Week 1: spike (decides rows 27 and 28)

Done on 2026-11-05: steps 1 to 6, except the presenter window. reveal.js's
notes plugin was tried and dropped: its preview frames reload the page URL,
so they show the app shell and the default document instead of the deck
(decision 8 already calls for a BroadcastChannel presenter window). Other
limits still open: footnotes
render only in the section that holds their definition; raw HTML is dropped
until rehype-raw is added behind the sanitizer; overflowing slides scroll
inside the slide with a diagnostic when even an atomic block does not fit.

1. Write the acceptance fixture in `fixtures/`: a long synthetic design doc
   with many `##` and `###` sections, flowcharts, sequence and state
   diagrams, long lists, an oversized table, code and links. No personal
   content.
2. Scaffold: pnpm, Vite 8, React 19, TypeScript, Vitest 5, mise pins.
3. AST sectioning with the auto base level, title slides, breadcrumbs and
   thematic breaks, with unit and property tests.
4. reveal.js 6 embedded in a container React does not reconcile; slides
   rendered from the sections; presenter window.
5. Mermaid 12 in `strict` behind the pre-pass; diagram focus with d3-zoom and
   with `@panzoom/panzoom`, then pick one.
6. Measurement pass and diagnostics, run in Vitest Browser Mode against the
   fixture.

Exit rule: if reveal.js still needs patches at the end of week 2, replace it
with a custom shell (overview grid, keyboard, fullscreen).

### After the spike

- Presenter window over `BroadcastChannel`: current and next slide, notes,
  timer; the audience window stays the source of the rendered deck.
- Done 2026-11-05: H3 fallback and semantic pagination (paragraphs, list
  items with `<ol start>`, table rows with repeated headers, "· continued"
  titles, `<section-id>/<page>` addresses). The fixture goes from 23 slides
  with 10 overflowing to 47 slides with 1 (an atomic block).
- Pagination refinement: merge adjacent sub-heading groups that fit on one
  slide together (today every H3 group gets its own slide once a section
  splits).
- Slide addresses in the URL (`#<section-id>/<page>`) and deep links from
  GitHub anchors.
- CodeMirror 6 editor with live preview and inline diagnostics.
- Inputs: drop, `?src=` with the origin allowlist, `?repo=`, pasted token.
- Worker: GitHub App OAuth (PKCE, `state`, fixed `redirect_uri`, origin-bound
  CORS), with `@cloudflare/vitest-plugin` tests.
- Sharing: fragment codec, autosave.
- Pen and laser; overview; themes; light/dark.
- Exports: PDF, single-file HTML, PNG.
- PWA; Paraglide i18n scaffolding; accessibility pass to WCAG 2.2 AA.
- CI: static build, Playwright on three engines, axe, size-limit, Lighthouse
  CI, sanitizer corpus, nightly Stryker.
- Cloudflare deploy with the `_headers` CSP; static build with the meta CSP.
- Done 2026-11-05: `DESIGN.md`, token module, parity test, self-hosted fonts, Stage look on the deck.
- App shell on React Aria: outline with page counts and note badges, ⌘K command palette, view switch (edit/document/present), settings; light/dark toggle.

## v1.1

- Remote control: phone remote and followers through Durable Object
  WebSocket rooms, joined by code or QR, with end-to-end encrypted
  navigation events.

## Later

- Monaco as an optional editor behind the editor interface.
- Turkish UI, then more locales through Weblate; RTL with CSS logical
  properties.
- GitHub Pages static deploy, once the repository is public.
- Canvas mode with Excalidraw and `@excalidraw/mermaid-to-excalidraw`.
- Comments anchored to headings or Mermaid node ids (`data-id`).
