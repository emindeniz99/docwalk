# Memory — docwalk

What the next session needs to know. Read before working; update after
significant work; prune past ~100 lines. One dated line per entry; rewrite
**Now** in place, append to the other sections.

## Now

Round 1 is merged into `claude/docwalk` (2026-11-05): nine tracks (ci, deck,
markdown, pwa, monaco, canvas, comments, workspace, mcp), each a real merge
commit, plus cross-track fixes. `pnpm check` passes (855 unit/browser incl.
mcp/, 30 Worker tests, build); `pnpm size` first load is 386 kB gzip (warn 500 kB, fail
1 MB); `pnpm test:e2e` runs every spec on Chromium, Firefox and WebKit plus
a `/docwalk/` sub-path project. Decision rows run to 67: 60-62 Markdown
fidelity, 63 offline, 64 canvas, 65 comments, 66 workspace, 67 agent parts.
None of the new GitHub workflows (three-engine e2e, Lighthouse, Stryker,
deploys) has run on GitHub yet. Open work is in ROADMAP "Follow-ups".

Local run in the cloud container: `PATH=/opt/node24/bin:$PATH npx -y
pnpm@12.16.1 --dir <project> <script>`; browser tests need
`DOCWALK_CHROMIUM_PATH=/opt/pw-browsers/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell`,
e2e `DOCWALK_CHROMIUM_FULL_PATH=/opt/pw-browsers/chromium`; Firefox and
WebKit come from `PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers`. A busy port:
`DOCWALK_E2E_PORT` (the sub-path build takes the next one).

## Decisions

- 2026-11-05: The full decision list lives in `docs/decisions.md` (67 rows); the evidence is in `docs/prior-art.md`. This file stays short.
- 2026-11-05: Thin viewer on reveal.js, Mermaid, drauu and unified, over forking Slidekick, Marp Core or Slidev + WebContainer: Slidekick splits on H1 and silently shrinks, Marp Core v5 is a release candidate, WebContainer needs a paid licence for employee use.
- 2026-11-05: Vite SPA + Cloudflare Worker over Vinext: the UI runs entirely in the browser, and Vinext is pre-1.0.
- 2026-11-05: Full semantic pagination and OAuth ship in v1, against a reviewer's advice to stage them. Slides are addressed by section id to keep links stable.
- 2026-11-05: Parallel tracks append decision rows independently; the merge renumbers them in merge order and fixes every reference (round 1: pwa 60→63, canvas →64, comments →65, workspace →66, mcp →67).

## Learnings

- 2026-11-05: reveal.js: `keyboardCondition: "focused"` ignores Tab and programmatic focus (use a DOM-focus function); slides sit at z-index 10-12; it binds Escape and O (rebound to no-ops); it paints `.reveal` backgrounds; scroll view starts at 435 px (`scrollActivationWidth: 0`); distant slides are `display: none` (measure clones); any nested `<section>` becomes a vertical slide (content sections become divs); it lays out only on window resize (panels dispatch one).
- 2026-11-05: Paginate before reveal.js initializes, split on the AST (its Markdown plugin is not fence-aware), and fit diagrams from the SVG viewBox; measure each Mermaid host, not only the slide.
- 2026-11-05: Fullscreen only paints the fullscreen element's subtree; put the page root in fullscreen or portalled dialogs vanish.
- 2026-11-05: Firefox and WebKit really enter fullscreen under Playwright and keep Escape for leaving it; the page never sees the key. App replays Escape into an open dialog on `fullscreenchange`, so the overview or sketch closes and presenting continues windowed.
- 2026-11-05: Integration bugs pass per-module tests and show only in the assembled app; round 1's merge found three (comments lost on workspace files, agent writes skipping the comments edit path, a 16.7 MB precache).
- 2026-11-05: React Aria: `ListBox` with `selectionMode` reports clicks as `onSelectionChange`; collections cache rows per item object (put row data in the items or pass `dependencies`); `GridListItem` takes its name from `textValue`; Tree rows are DOM siblings; Radio, Switch and Checkbox inputs are visually hidden (click the label or card in Playwright); modals portal to `<body>` (block app keys with a document listener, not stopPropagation on the dialog).
- 2026-11-05: Vite loads TS configs natively; config-side files import with `.ts`. Vitest inline projects need `extends: true` to inherit root plugins. The node tsconfig has no DOM: a test touching `matchMedia` must be `*.browser.test.ts`.
- 2026-11-05: Sanitizing: DOMPurify's SVG profile strips `foreignObject` (Mermaid runs with `htmlLabels: false`); hast-util-sanitize re-prefixes ids remark-rehype already prefixed (`clobberPrefix: ''`, resolve `#x` in code); rehype-raw throws on `<template>` inside SVG (catch and re-render without raw HTML); the GitHub schema unwraps `<style>` (strip it with its contents).
- 2026-11-05: GitHub's OAuth token exchange needs `client_secret` and has no CORS: browser-only OAuth is impossible, hence the Worker. A `<meta>` CSP cannot carry `frame-ancestors`; the sanitizer is the image gate.
- 2026-11-05: axe misses `contenteditable` as tabbable (CodeMirror `.cm-content` gets `tabindex="0"`) and cannot judge contrast on reveal's scaled slide (assert colours with `getComputedStyle`). Run axe after CSS transitions settle (`document.getAnimations()`), or WebKit measures mid-fade colours.
- 2026-11-05: Property tests must reuse one parsed tree; re-parsing makes new node objects and identity checks fail for no real reason.
- 2026-11-05: Playwright: `routeWebSocket` without `connectToServer` relays multi-page remote tests, but cannot carry a Node child's socket (run a local `ws` relay); `addInitScript` reaches `srcdoc` iframes; `context.route` never sees a service worker's update check (serve dist/ from an in-test server).
- 2026-11-05: Playwright engines: WebKit sends a service-worker-controlled page's requests past routing (config blocks workers; only pwa.spec allows them); WebKit refuses OPFS in throwaway contexts (`opfsTest` uses a persistent one); Firefox `insertText` over a selection inserts nothing (delete first); only Chromium grants clipboard permissions; headless Firefox fullscreen is 1366 px wide; Firefox mobile emulation opens menus on `tap()`, not `click()`; Firefox's HTTP cache answers offline fetches (`cache: "no-store"`) and its offline mode still lets navigations to localhost through; `Page.getInstallabilityErrors` always reports `in-incognito`.
- 2026-11-05: WebKit's OPFS keeps whole-second `lastModified`; the local-folder poll compares text while a file's time is under 2 s old.
- 2026-11-05: Chromium 1243 aborts with SIGTRAP when an OPFS directory handle stored in IndexedDB is read back in a new document; workspace.spec stubs the handle with a marker.
- 2026-11-05: Nowrap text in a flex item sets the header's min-content width even with overflow hidden; `contain: inline-size` stopped a 390 px page scrolling sideways.
- 2026-11-05: oxlint's React compiler rules reject synchronous setState in effects; derive the state or adjust it during render.
- 2026-11-05: drauu `load()` clears its undo stack: keep one drauu instance per slide key.
- 2026-11-05: Importing anything from `deck/Deck.tsx` pulls reveal.js into the importer's chunk; non-deck code imports from `deck/pages.ts`.
- 2026-11-05: Mermaid 12.2 names node groups `<render-id>-<kind>-<source id>-<n>`; sequence and gantt diagrams have no node ids (guarded by `diagramNodes.browser.test.ts`).
- 2026-11-05: `indexedDB.deleteDatabase` waits forever while a page holds a connection; close on `versionchange`, or use a new browser context.
- 2026-11-05: Excalidraw 0.18 lists esm.sh as a second source of every FontFace; `tooling/excalidraw-assets-plugin.ts` rewrites it at build time and fails if the code moves. Convert Mermaid only after Excalifont has loaded, or every label is clipped.
- 2026-11-05: pnpm `trustPolicy: no-downgrade` rejects vite-plugin-pwa (workbox-build) and mermaid-to-excalidraw 2.x (langium 3.3.1); the Workbox runtime modules and mermaid-to-excalidraw 3 plus an override pass.
- 2026-11-05: The PWA plugin chooses chunks by the import graph and other files by who names them; an opt-in mode's fonts or worker must never reach the precache (check `docwalk-pwa: precaching` in the build log, about 3 MB).
- 2026-11-05: Monaco sits behind the decision 4 contract (one driver per editor in `SourceEditor.browser.test.ts`); its markers do not move with edits (re-derived per change), the editor-level bracket colouring option is ignored (set it on the model), glyph hovers render Markdown (escape them), and it is 831 kB gzip (`pnpm size` fails if `MonacoEnvironment` reaches the first load).
- 2026-11-05: Agent messages over the relay's 16 KB frame travel as deflated, encrypted, addressed parts (decision 67); agent writes take the editor's `onEdit`, so comments and the workspace treat them as typed edits.
- 2026-11-05: Stryker 10's tsconfig preprocessor needs a TypeScript JS API that TypeScript 7 dropped (point `tsconfigFile` at a missing file). CI's pnpm/action-setup needs `package_json_file`; `pnpm deploy` is pnpm's own command (`pnpm run deploy`).

## Done

- 2026-11-05: Round 1 merged: CI on three engines with Lighthouse, Stryker and deploy workflows; slide overview and merged sub-heading pages; GitHub alerts, footnotes, raw HTML and heading anchors; offline PWA; Monaco; canvas mode; comments; workspace and local folders; docwalk-mcp.
- 2026-11-05: Batch 2 (inputs, share, export, Worker, remote) integrated with e2e and axe suites; 12 integration defects fixed.
- 2026-11-05: Parallel build of editor, annotation, presenter and URL modules, integrated, e2e suite added.
- 2026-11-05: Design: three directions, mix chosen (decision 49), DESIGN.md + tokens + parity test, Stage look applied.
- 2026-11-05: Semantic pagination, week-1 spike, acceptance fixture, prior-art research and project docs.
