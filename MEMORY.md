# Memory — docwalk

What the next session needs to know. Read before working; update after
significant work; prune past ~100 lines. One dated line per entry; rewrite
**Now** in place, append to the other sections.

## Now

2026-11-08: v1 and the v2 workspace and agent work are built, three
review passes are fixed, and the project is public at
github.com/emindeniz99/docwalk with the static build on GitHub Pages
(`deploy-pages.yml` runs after CI passes on `main`, or by hand). On
2026-11-06 code colours (76), the fill frame (77), per-slide presenter
previews, the old-browser notice (78), document-mode hash links and
safe-area padding landed. Decision rows run to 81. CI (three-engine e2e,
Lighthouse, zizmor) is green on GitHub; the nightly Stryker run was fixed
on 2026-11-08 (`disableTypeChecks` must skip HTML). Small safe changes go
straight to `main`, larger work on a branch merged with `--no-ff`
(CONTRIBUTING). Next features are ranked in `docs/feature-gaps.md`; open
work and owner tasks are in ROADMAP "Follow-ups".

`pnpm size` tracks only the app shell (index.html plus App's preloads);
`e2e/perf.spec.ts` (Chromium) holds the default view's real download to
1 MB gzip (979 kB used) and times the fixture's open and repaginate
against decision 43. The 1.5 s open budget does not hold: on 2026-11-08 a
Windows desktop (Ryzen 7 7800X3D) took a median of 1774 ms over 7 runs
(worst 1973 ms), the CI runner 2559 ms; repaginate holds (214 ms median).

Local runs: browser tests take a Chromium binary from
`DOCWALK_CHROMIUM_PATH` (a headless shell is enough); e2e takes a full
Chromium from `DOCWALK_CHROMIUM_FULL_PATH` (fullscreen and pop-ups), and
Firefox and WebKit from `PLAYWRIGHT_BROWSERS_PATH`. A busy port:
`DOCWALK_E2E_PORT` (the sub-path build takes the next one). Playwright
reuses a server already listening on both ports outside CI.

## Decisions

- 2026-11-05: The full decision list lives in `docs/decisions.md`; the evidence is in `docs/prior-art.md`. This file stays short.
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
- 2026-11-06: A size budget built from the HTML and preload lists misses what the app fetches after mount (the editor chunk, Mermaid's diagram types, ELK): 398 kB counted against 1339 kB downloaded. Sum the real responses in Playwright.
- 2026-11-06: Repository secrets reach every workflow on every branch; only environment secrets wait for the environment's branch rules and reviewers.
- 2026-11-06: A history rewrite that edits only commit messages leaves old file revisions intact; README, decisions and MEMORY carried private links for two commits. `--replace-text` rewrites every revision, and `git log -p --format=%B | grep` proves the result.
- 2026-11-06: reveal.js rounds its scale to 0.01 after `maxScale`; with `margin: 0` the slide overhung the screen by up to 0.5% (1446 px at 1440). Capping `maxScale` at the fit rounded down (set before reveal's own resize listener) keeps it inside. Its default `maxScale` of 2 also stops a slide short of screens wider than 2560 CSS px.
- 2026-11-06: Chromium 1243 emulates safe-area insets through CDP `Emulation.setSafeAreaInsetsOverride` (present-frame.spec); Firefox and WebKit have no such switch.
- 2026-11-06: Shiki: `@shikijs/primitive` (tokenizer only) is 6 kB gzip smaller than `@shikijs/core`'s highlighter; the JavaScript regex engine is about 20 kB of it. The CSS-variables theme's colours (`var(--prefix-token-…)`) work as lookup keys, and `fontStyle: false` drops weight and italics. Grammars imported from docwalk's own code are precached unless listed in `RUNTIME_CACHED_PACKAGES`. `DOMPurify` here forbids `style`, so colour must travel as classes.
- 2026-11-06: WebKit lays out hidden, off-screen elements again on every forced layout elsewhere on the page: the presenter's 23 attached hidden slides made pagination and notes 4.5 s instead of 1 s (`contain: strict` did not help; detaching did). The audience deck does not pay this (reveal.js keeps its sections out of layout).
- 2026-11-06: In WebKit a popup opened with `window.open` shares the opener's main thread: a long task in the presenter window stalls the audience deck. Build in slices; WebKit has no `scheduler.yield` (fall back to a zero timeout). A 10 ms timer's longest gap in each window measures the stall; WebKit has no Long Tasks API.
- 2026-11-06: A test that types several characters and then waits for "the" rebuilt deck can meet two rebuilds when the typing pauses past `REBUILD_DELAY_MS` under load; wait for the deck that shows the whole edit.
- 2026-11-06: Any edit to index.html's inline script changes its CSP hash (decision 78): recompute the SHA-256 of the script text and update `worker/csp.ts` and `public/_headers`; `csp-plugin.test.ts` fails until they match.
- 2026-11-06: At 1440×900 the presented slide is bound by width, so hiding the presenting controls (decision 75) does not grow it; a size test needs a phone-landscape viewport (844×390). Playwright's `devices["iPhone 15 landscape"]` is 734×343 and has no safe-area insets.
- 2026-11-08: Stryker's default `disableTypeChecks` also writes `// @ts-nocheck` into HTML script blocks, which changed index.html's inline script and its CSP hash in the sandbox; the config now names source files only.
- 2026-11-08: Dependabot's npm job refuses an exact `devEngines.runtime` Node pin that differs from its own Node ("tool_version_not_supported"); move the pin to its version once that release is seven days old. GitHub's CI run on `main` cancels the previous one (concurrency group), so a cancelled run after a quick second push is expected.
- 2026-11-08: Vitest's `expect.poll` moves fake timers 50 ms per try, so a test that polls after `useFakeTimers` starts its clock late (use a loop of message-channel tasks); React commits in a message-channel task the fake clock leaves alone, so read the page after one. `pacing.ts` and `Pacing.tsx` cannot share a folder on a case-insensitive disk (TS1149).
- 2026-11-08: Playwright's `context.clock.install()` fakes `Date` and timers in the main tab and in a popup, and lets time run between jumps; `fastForward` fires each due timer once, so a test that needs the page to have seen the jump waits on a second clock (the Elapsed timer). A popup opened with `window.open` starts with a copy of its opener's `sessionStorage`; the countdown key is never written there.
- 2026-11-08: CommonMark lets an unclosed `<!--` swallow the rest of the document as one `html` node, and a comment above the first heading opens a slide of its own (`intro`, blank in the presenter list). Speaker notes ignore the first and hand the second's notes to the next slide.
- 2026-11-08: React Aria's Menu draws its empty state ("No match") inside a `role="menuitem"` wrapper, so a test that counts menu items must leave out the one holding `.docwalk-palette-empty`. `useFilter({ sensitivity: "base" })` collates with the UI locale: under `tr-TR` ç, ğ, ö, ş and ü are separate letters (`gec` misses `geç`), I matches ı and i matches İ; under `en-US` İ matches i and I, and ı matches neither. A sliding `Intl.Collator.compare` over a 30 kB document costs under 2 ms per query.
- 2026-11-08: Playwright's `toMatchAriaSnapshot` matches a template as a subsequence, so name only what the engines share (`e2e/aria-snapshots.spec.ts`). Real differences: WebKit lacks the Files panel and workspace commands (no OPFS in a throwaway context) and reads the palette hint as "K" (its Desktop Safari profile is a Mac, and the ⌘ glyph is `aria-hidden`); only Chromium offers "Open local folder…". The template syntax breaks on `: ` inside a regex name (`/Theme: system/` fails to parse). Port 4190 (ManageSieve) is a restricted port: Firefox and WebKit cannot load pages from it, so `DOCWALK_E2E_PORT=4190` fails there while Chromium passes. A Playwright run on Windows can leave its `vite preview` running; the next run on that port reuses it and its old `dist`, so rebuild or change the port after editing source.

## Done

- 2026-11-08: Closed ROADMAP "Still open in v1" (decisions 82 to 85, branch `feat/roadmap-next-up`): remote control, overview and Lighthouse refinements recorded; `e2e/aria-snapshots.spec.ts` (8 tests, three engines, no screenshot assertions because PNG baselines cannot be made for Ubuntu here); the 1.5 s open budget re-measured and still missed (see Now).
- 2026-11-08: Full-text slide search in the palette (decision 81, branch `feat/roadmap-next-up`): `SlideInfo.text` is read lazily from the paginated page (`src/deck/slideText.ts`), `src/shell/slideSearch.ts` finds the first match with the title filter's collator and cuts a snippet, and the palette lists hits under "In slide text" (ten at most, a count of the rest). Mermaid labels and speaker notes are not searched.
- 2026-11-08: Countdown, pacing bar and screen wake lock (decision 80, branch `feat/roadmap-next-up`): the presenter window takes a target in minutes and counts down with pause and reset, goes negative with words and an icon when over, and sets time used against slides done from the address list; the clock lives in the window's `sessionStorage`, apart from the bridge's `startedAt`; the wake lock is held while presenting and while the presenter window is open.
- 2026-11-08: Speaker notes (decision 79, branch `feat/roadmap-next-up`): the closed HTML comments of a section, minus tool directives, show under the current slide in the presenter window; read from the AST in `src/sectioning/notes.ts`, printed as text, no new bridge field and no other surface sees them.
- 2026-11-06: Presenter previews built off the page and slide by slide, current and next first (WebKit opener stall 5-6 s to under 1 s); document mode opens a linked heading; old browsers get a notice (decision 78); toast and centred dialogs pad for the safe area; pen-marks test waits for the final rebuilt deck.
- 2026-11-06: Present frame (decision 77): the slide fills the screen by default, the bar lies over it while it hides, the ground takes the slide's colour; the card stays as a More menu and palette option.
- 2026-11-06: Code blocks coloured by language (decision 76): Shiki tokenizer as a lazy chunk, DOM colouring after both sanitizers, GitHub's colours as tokens with a contrast test, grammars cached on first use.
- 2026-11-06: Presenting controls hide when idle and the slide takes the stage (decision 75); safe-area padding under `viewport-fit=cover`; Home Screen note for iPhone in the README.
- 2026-11-05: Round 1 merged: CI on three engines with Lighthouse, Stryker and deploy workflows; slide overview and merged sub-heading pages; GitHub alerts, footnotes, raw HTML and heading anchors; offline PWA; Monaco; canvas mode; comments; workspace and local folders; docwalk-mcp.
- 2026-11-05: Batch 2 (inputs, share, export, Worker, remote) integrated with e2e and axe suites; 12 integration defects fixed.
- 2026-11-05: Parallel build of editor, annotation, presenter and URL modules, integrated, e2e suite added.
- 2026-11-05: Design: three directions, mix chosen (decision 49), DESIGN.md + tokens + parity test, Stage look applied.
- 2026-11-05: Semantic pagination, week-1 spike, acceptance fixture, prior-art research and project docs.
