# Decision index

Settled 2026-11-05 after a prior-art study and two independent design
reviews. [`prior-art.md`](./prior-art.md) holds the survey, the rejected
alternatives and the evidence behind most rows.

Reversing or narrowing a row needs an ADR in `docs/adr/` that names the row it
supersedes. Mark the row `superseded` and link the ADR; never rewrite a row in
place.

## Product

| #   | Decision                                                                                                                                                                                                             | Status   |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| 1   | Name `docwalk`; MIT licence; open source                                                                                                                                                                             | accepted |
| 2   | Public tool for teams and individuals; every input is hostile                                                                                                                                                        | accepted |
| 3   | Four modes: editor with live preview, document, presentation, diagram focus                                                                                                                                          | accepted |
| 4   | CodeMirror 6 behind a five-method editor interface; Monaco is a roadmap item (no mobile support, no Markdown IntelliSense to gain)                                                                                   | accepted |
| 5   | Inputs: paste, file drop, `?src=<url>`, `?repo=&path=`, a pasted fine-grained token, GitHub App OAuth                                                                                                                | accepted |
| 6   | `?src=` loads raw.githubusercontent.com and gist directly; other origins need a confirmation and show a "loaded from X" banner                                                                                       | accepted |
| 7   | Sharing: link-based (`?src=`/`?repo=`) first; pasted docs fall back to a `CompressionStream` deflate-raw + base64url `#fragment` with a length warning and a browser-history note; drafts autosave to `localStorage` | accepted |
| 8   | Presenter window on the same machine over `BroadcastChannel` in v1; phone remote and followers through Durable Object rooms with end-to-end encrypted navigation events in v1.1                                      | accepted |
| 9   | Export to PDF (print CSS), a single self-contained HTML file and PNG per slide                                                                                                                                       | accepted |
| 10  | GitHub-style document mode, 2–3 slide themes, light/dark following the system with a toggle                                                                                                                          | accepted |
| 11  | Installable PWA that works offline                                                                                                                                                                                   | accepted |
| 12  | No analytics or telemetry                                                                                                                                                                                            | accepted |

## Sectioning and pagination

| #   | Decision                                                                                                                                                                                                                          | Status   |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| 13  | Sectioning runs on the Markdown AST; no regex splitting                                                                                                                                                                           | accepted |
| 14  | Slide level picked by Pandoc's rule: the highest heading level followed directly by content                                                                                                                                       | accepted |
| 15  | A heading above the slide level gets a title slide only when it has its own content; breadcrumbs appear on every slide below it                                                                                                   | accepted |
| 16  | A thematic break forces a slide                                                                                                                                                                                                   | accepted |
| 17  | An overflowing slide with lower headings splits one level down, keeping the parent in the breadcrumb                                                                                                                              | accepted |
| 18  | Full semantic pagination ships in v1: paragraph, list-item and table-row boundaries, repeated table headers, "· continued" titles                                                                                                 | accepted |
| 19  | Code blocks, diagrams and images are atomic; one taller than an empty slide gets a diagnostic; no global shrink                                                                                                                   | accepted |
| 20  | Level override in the UI and URL: `auto`, H1, H2, H3 or a list                                                                                                                                                                    | accepted |
| 21  | Slides are addressed as `<section-id>/<n>`, never by absolute index                                                                                                                                                               | accepted |
| 22  | Measurement order: fonts ready, `mermaid.run()`, image decode, one animation frame; measure the slide and each Mermaid host; `ResizeObserver` re-checks; binary search over whole blocks in a hidden slide-sized box; cached SVGs | accepted |

## Architecture

| #   | Decision                                                                                                                                                           | Status                |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------- |
| 23  | React 19 + Vite 8 SPA in TypeScript; no router at first (three views in URL state)                                                                                 | accepted              |
| 24  | One Cloudflare Worker (Hono) via `@cloudflare/vite-plugin` for `/api`; Vinext rejected (no server rendering to gain, pre-1.0)                                      | accepted              |
| 25  | Parsing: remark-parse, remark-gfm, remark-rehype, rehype-sanitize (GitHub schema), rehype-github-alert, then DOMPurify                                             | accepted              |
| 26  | Mermaid 12 pinned, lazy ESM, `strict`; pre-pass strips `%%{init}%%`, image shapes and `url()`; `bindFunctions` never called; SVG through DOMPurify                 | accepted              |
| 27  | reveal.js 6 embedded (`hash: false`, scoped keyboard), rendering into a container React does not reconcile; switch to a custom shell if week 2 still needs patches | accepted, spike-gated |
| 28  | Zoom/pan with d3-zoom or `@panzoom/panzoom`, chosen in the first spike                                                                                             | open until spike      |
| 29  | Drawing with `@drauu/core` inside the diagram transform; custom laser on `perfect-freehand`                                                                        | accepted              |
| 30  | i18n with Paraglide JS + ICU plugin + Weblate Libre; English first; locale switch keeps the draft                                                                  | accepted              |
| 31  | Browsers: Baseline widely available, Safari 17.4 floor; older browsers get a notice and the plain Markdown                                                         | accepted              |
| 32  | Dependencies: newest versions at least 7 days old (pnpm `minimumReleaseAge: 10080`), bumped automatically                                                          | accepted              |

## Security and hosting

| #   | Decision                                                                                                                                                                                                                                             | Status   |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| 33  | The sanitizer is the image gate: `src` rewritten to `data-src`, loaded on click or by the "always load" setting; CSP allows `img-src 'self' https: data: blob:`                                                                                      | accepted |
| 34  | Cloudflare serves a real CSP header from `_headers` (`script-src 'self'`, `style-src 'self' 'unsafe-inline'`, `worker-src 'self' blob:`, `frame-ancestors 'none'`); static mode ships a `<meta>` CSP without `frame-ancestors`, documented as weaker | accepted |
| 35  | Pasted tokens live in `sessionStorage` only, with a revoke link                                                                                                                                                                                      | accepted |
| 36  | OAuth through a GitHub App (`Contents: read`, user-selected repos); the Worker exchanges code and refresh tokens, stores nothing, requires PKCE `S256` + `state`, fixes `redirect_uri`, limits CORS to the app origin, logs no tokens                | accepted |
| 37  | Hosting: Cloudflare runs the full deploy; GitHub Pages runs the static deploy once the repository is public; CI tests the static build from day one                                                                                                                | accepted |
| 38  | Self-host: static mode on any host, full mode via `wrangler deploy` with your own GitHub App                                                                                                                                                         | accepted |

## Quality

| #   | Decision                                                                                                                                                                         | Status   |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| 39  | Vitest 5 for units; Vitest Browser Mode (Playwright provider) for layout; Playwright end-to-end with screenshots and ARIA snapshots on three engines                             | accepted |
| 40  | fast-check property tests for pagination; StrykerJS nightly on node-environment tests                                                                                            | accepted |
| 41  | axe-core in CI; target WCAG 2.2 AA                                                                                                                                               | accepted |
| 42  | Sanitizer tests: DOMPurify fixture corpus plus fuzzing with a sanitize-twice check, on all three engines                                                                         | accepted |
| 43  | Budgets via size-limit and Lighthouse CI: about 250 KB gzipped first load, 1.5 s to open a 500-line doc in presentation mode, 300 ms to repaginate, measured against the fixture | accepted |
| 44  | Worker tests with `@cloudflare/vitest-plugin`                                                                                                                                    | accepted |
| 45  | The acceptance fixture is a long synthetic design doc with no personal content                                                                                                   | accepted |
