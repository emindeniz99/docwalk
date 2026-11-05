# Memory — docwalk

What the next session needs to know. Read before working; update after
significant work; prune past ~100 lines. One dated line per entry; rewrite
**Now** in place, append to the other sections.

## Now

v1 features are in and a full review (5 dimensions, adversarially verified)
found 37 defects; all are fixed with a failing-first test each. `pnpm check`
passes (508 unit/browser + 30 Worker tests, no dist/ needed); `pnpm test:e2e`
runs 31 Playwright tests with axe on nine surfaces; `pnpm size` (size-limit,
in CI) measures first load (295 KB gzip JS+CSS); fails above 1 MB, warns above 500 KB. CSP
`connect-src` is now `'self' https: wss:` (decision 34) and the static build
carries a meta CSP. Open: decision row 8 needs an ADR (remote moved into v1);
the presenter window still pulls reveal.js through `deck/Deck.tsx` exports
(move `SLIDE_SIZE`/`slideAddress` to a small module); v2 workspace and agent
plan in ROADMAP.

Local run in the cloud container: `PATH=/opt/node24/bin:$PATH npx -y
pnpm@12.16.1 --dir <project> <script>`; browser tests need
`DOCWALK_CHROMIUM_PATH=/opt/pw-browsers/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell`.

## Decisions

- 2026-11-05: The full decision list lives in `docs/decisions.md` (48 rows); the evidence is in `docs/prior-art.md`. This file stays short.
- 2026-11-05: Thin viewer on reveal.js, Mermaid, drauu and unified, over forking Slidekick, Marp Core or Slidev + WebContainer: Slidekick splits on H1 and silently shrinks, Marp Core v5 is a release candidate, WebContainer needs a paid licence for employee use.
- 2026-11-05: Vite SPA + Cloudflare Worker over Vinext: the UI runs entirely in the browser, and Vinext is pre-1.0.
- 2026-11-05: Full semantic pagination and OAuth ship in v1, against a reviewer's advice to stage them. Slides are addressed by section id to keep links stable.

## Learnings

- 2026-11-05: reveal.js `keyboardCondition: "focused"` only counts pointer presses on the deck; Tab and programmatic focus leave it deaf. Use a function that checks DOM focus.
- 2026-11-05: reveal.js stacks slides at z-index 10 to 12; overlays inside `.slides` need a higher z-index.
- 2026-11-05: reveal.js binds Escape to its overview and marks the event handled; rebind 27 to a no-op so the app owns Escape.
- 2026-11-05: Fullscreen only paints the fullscreen element's subtree; put the page root in fullscreen or portalled dialogs vanish.
- 2026-11-05: Five integration bugs passed 154 unit/browser tests and showed only in the assembled app; the e2e suite now guards each one (verified by reintroducing the keyboard bug).
- 2026-11-05: React Aria `ListBox` with `selectionMode` reports clicks as `onSelectionChange`, not `onAction`.
- 2026-11-05: Vite loads TS configs natively now and warns on extensionless relative imports; config-side files import with `.ts` (tsconfig `allowImportingTsExtensions`).
- 2026-11-05: Vitest inline projects ignore root `plugins` unless each project sets `extends: true`.
- 2026-11-05: reveal.js paints `.reveal`/`.reveal-viewport` backgrounds; make them transparent or the stage colour never shows.
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
- 2026-11-05: reveal.js turns on its scroll view when the deck is 435 px wide or less (`scrollActivationWidth`): a phone or a narrow preview stacked every slide at full size. Deck sets it to 0.
- 2026-11-05: axe does not count `contenteditable` as tabbable, so CodeMirror's scroller failed scrollable-region-focusable until `.cm-content` got `tabindex="0"`. A React Aria Autocomplete menu only takes virtual focus; scroll the dialog that holds the search field instead.
- 2026-11-05: `role="button"` on a diagram host made the diagram's text presentational and failed label-in-name; a focusable `group` keeps Enter-to-open and the labels.
- 2026-11-05: Playwright `context.routeWebSocket` without `connectToServer` is a working relay for multi-page remote tests; `addInitScript` also runs in `srcdoc` iframes, so it can stub the print frame's `print()`.
- 2026-11-05: SourceBanner and the editor pane both used `.docwalk-source`; module CSS must check the shell's class names.

## Done

- 2026-11-05: Batch 2 (inputs, share, export, Worker, remote) integrated with e2e and axe suites; 12 integration defects fixed (scroll view on phones, axe findings, class collision, phone layout).
- 2026-11-05: Parallel build of editor, annotation, presenter and URL modules (4 builders + 4 reviewers, 16 defects fixed in review), integrated, e2e suite added.
- 2026-11-05: Design: three directions on a Claude Design canvas, mix chosen (decision 49), DESIGN.md + tokens + parity test, Stage look applied.
- 2026-11-05: Semantic pagination: fixture 23 slides/10 overflowing -> 47 slides/1 (atomic), no text lost (browser test).
- 2026-11-05: Week-1 spike: reveal.js deck, Mermaid focus, overflow diagnostics; fixture shows 23 slides, 0 diagram errors, 10 honestly flagged overflows.
- 2026-11-05: Acceptance fixture `fixtures/ledger-redesign.md` (809 lines, 7 Mermaid diagrams, all parse with Mermaid 11.12).
- 2026-11-05: Prior-art research, design review, decision list and project docs.
