# Memory — docwalk

What the next session needs to know. Read before working; update after
significant work; prune past ~100 lines. One dated line per entry; rewrite
**Now** in place, append to the other sections.

## Now

Spike plus smart pagination done: AST sections, H3 fallback, semantic
pagination (items, rows, blocks), sanitized reveal.js deck, Mermaid strict +
pre-pass, diagram fitting and focus view, off-screen measurement. `pnpm
check` passes (23 unit + 18 browser tests). Next: presenter window
(BroadcastChannel), slide addresses in the URL, then the CodeMirror editor.

Local run in the cloud container: `PATH=/opt/node24/bin:$PATH npx -y
pnpm@12.16.1 --dir <project> <script>`; browser tests need
`DOCWALK_CHROMIUM_PATH=/opt/pw-browsers/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell`.

## Decisions

- 2026-11-05: The full decision list lives in `docs/decisions.md` (48 rows); the evidence is in `docs/prior-art.md`. This file stays short.
- 2026-11-05: Thin viewer on reveal.js, Mermaid, drauu and unified, over forking Slidekick, Marp Core or Slidev + WebContainer: Slidekick splits on H1 and silently shrinks, Marp Core v5 is a release candidate, WebContainer needs a paid licence for employee use.
- 2026-11-05: Vite SPA + Cloudflare Worker over Vinext: the UI runs entirely in the browser, and Vinext is pre-1.0.
- 2026-11-05: Full semantic pagination and OAuth ship in v1, against a reviewer's advice to stage them. Slides are addressed by section id to keep links stable.

## Learnings

- 2026-11-05: Paginate before reveal.js initializes; otherwise its slide count, progress bar and overview describe the unsplit deck.
- 2026-11-05: reveal.js's notes plugin opens previews of `location.href`; for an app whose deck comes from pasted input, the previews show the wrong thing. Build the presenter window on BroadcastChannel instead.
- 2026-11-05: reveal.js hides distant slides with `display: none`, so they measure as empty; measure clones in an off-screen box with `visibility: hidden`.
- 2026-11-05: Fit diagrams from the SVG viewBox, not from layout: it works on hidden slides. Mermaid's own `max-width` style must be overridden or the fitted width is ignored.
- 2026-11-05: DOMPurify's SVG profile strips `foreignObject`, which Mermaid uses for HTML labels; run Mermaid with root `htmlLabels: false` so labels are SVG text.
- 2026-11-05: reveal.js's Markdown plugin discards the separator match and is not fence-aware; split on the AST and hand reveal pre-built `<section>` HTML.
- 2026-11-05: GitHub's OAuth token exchange needs `client_secret` and has no CORS, PKCE included: browser-only OAuth is impossible, hence the Worker.
- 2026-11-05: A static `_headers` CSP cannot carry a per-visitor image setting, and a `<meta>` CSP cannot carry `frame-ancestors`: the sanitizer is the image gate.
- 2026-11-05: Mermaid and other diagram hosts hide their own overflow; measure each host, not only the slide (deckrun `src/preview.ts`).
- 2026-11-05: Pandoc's rule alone gives H1 slides for a README (`# Name` + intro). The lone-H1 title rule fixes that; restricting it to H1 keeps a single `##` with `###` children from being mistaken for a title.
- 2026-11-05: Property tests must reuse one parsed tree; re-parsing makes new node objects and identity checks fail for no real reason.

## Done

- 2026-11-05: Semantic pagination: fixture 23 slides/10 overflowing -> 47 slides/1 (atomic), no text lost (browser test).
- 2026-11-05: Week-1 spike: reveal.js deck, Mermaid focus, overflow diagnostics; fixture shows 23 slides, 0 diagram errors, 10 honestly flagged overflows.
- 2026-11-05: Acceptance fixture `fixtures/ledger-redesign.md` (809 lines, 7 Mermaid diagrams, all parse with Mermaid 11.12).
- 2026-11-05: Prior-art research, design review, decision list and project docs.
