# Roadmap: docwalk

Dated 2026-11-08. Update this file when an item ships or a deferred item's
trigger fires, and delete the entry in the same commit.

## v1

Done on 2026-11-05: the week-1 spike, semantic pagination, the app shell,
editor, annotation, presenter window, inputs, Worker with GitHub App OAuth,
sharing, exports, remote control, `DESIGN.md` and the Stage look. Round 1
(merged the same day) added:

- Done 2026-11-05: slide overview (O, grid button, palette) replacing
  reveal.js's; short sub-heading parts share a page after a split; undo
  history per slide; overflow notes in presenter previews; the presenter
  window no longer loads reveal.js.
- Done 2026-11-05: GitHub alerts, footnotes on the slide that cites them,
  raw HTML behind the GitHub schema, sub-heading and empty-slug anchors, a
  55-vector sanitizer corpus with sanitize-twice properties.
- Done 2026-11-05: installable offline PWA (decision 63) with an update
  prompt; the precache follows the import graph (about 3 MB).
- Done 2026-11-05: CI runs e2e on Chromium, Firefox and WebKit plus a
  `/docwalk/` sub-path build, Lighthouse CI budgets, zizmor, nightly
  Stryker; manual Cloudflare and GitHub Pages deploy workflows.
- Done 2026-11-06: Paraglide i18n with an English and a Turkish UI and a
  language switch (decisions 30, 56).
- Done 2026-11-06: design polish: a source and preview switch on phones,
  aligned presenter slides, an empty-deck hint, failed diagrams in the
  yellow note, the update prompt kept clear of the status bar and the next
  arrow, and a lone `# Title` document titled by its heading.
- Done 2026-11-06: graduated from the playground monorepo to this public
  repository, with the static build on GitHub Pages.
- Done 2026-11-06: presenting controls hide when idle (75); fenced code
  coloured by language with Shiki (76); a fill-the-screen present frame,
  with the card as an option (77); presenter previews built one slide at
  a time so the audience tab no longer stalls in WebKit; a notice instead
  of a blank page below the browser floor (78); document-mode links scroll
  to their heading; the update toast and dialogs pad for the safe area.

Still open in v1:

- Decision row 8 needs a later row or an ADR (remote control moved into v1).
- Decision 39's screenshot and ARIA-snapshot assertions are not written
  (screenshots are optional review captures). Write them, or narrow the row.
- Decision 43's 1.5 s open budget: `e2e/perf.spec.ts` measured about 2.5 s
  for the 809-line fixture on a build that still bundled ELK. It warns above
  the budget and fails only above three times it; re-measure on the current
  build.
- Record the round-1 refinements as decisions if wanted: the app's overview
  replaces reveal.js's (refines 3, 17, 27); Lighthouse performance floor 0.5
  and zero third-party requests (refines 43).

## v2: workspace and agents

Done 2026-11-05 (decisions 57 to 59, details 66 and 67): browser workspace in
OPFS with templates and zip import/export; local folders with save on
request, reload on change and conflict prompts; `docwalk-mcp` with "Allow
agent edits", whose writes land as edits of the open file (autosaved in the
browser workspace, unsaved until Save in a local folder). Also done that
day: Monaco as an optional editor (53), canvas mode (54, 64) and comments
(55, 65).

## Follow-ups

Needs the owner:

- Repository settings now that it is public: private vulnerability
  reporting, secret scanning and push protection (Settings, Security; then
  drop the paragraph in `SECURITY.md` that says they are switched on at
  that point); Actions' default token set to read-only; a ruleset on
  `main` that allows merge commits only; topics on the repository page.
- Cut the first tag, `v0.1.0`, once `main` is green.
- Cloudflare deploy, for sign-in and remote control: needs
  `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` as secrets of the
  `docwalk-cloudflare` environment, deployment branches limited to `main`.
  The workflow has not run yet.
- First npm publish of `docwalk-mcp`: trusted publishing cannot create a
  package, so the owner publishes the first version by hand.
- Escape in real fullscreen with a dialog open (see below): Chromium's
  Keyboard Lock would fix it but makes users hold Escape to leave
  fullscreen, and Firefox and Safari lack it. Keep the current behaviour,
  or accept that trade on Chromium.
- CI, Lighthouse, zizmor, the Pages deploy and the nightly Stryker run
  have all run on GitHub. zizmor's online audits and the pinned actions'
  tag ages were not checked.
- A real `showDirectoryPicker` folder on a real disk in desktop Chrome:
  handle kept in IndexedDB, permission asked again on return. Every test
  uses an OPFS handle in its place.
- `vite-plugin-pwa` stays out while `trustPolicy: no-downgrade` rejects
  workbox-build; the in-house plugin is the workaround, not a policy change.

Later rounds:

- Workspace: no fallback for Safari before 26 (no `createWritable`) or
  private windows (panel hidden); OPFS edits in another tab are not watched
  (last write wins); without `FileSystemObserver` new or removed files show
  on window focus only; `navigator.storage.persist()` is not requested;
  comments and sketches follow a rename or delete made in docwalk, not
  one made on disk or past the listing's 5000-entry cap.
- Agents: the e2e relay copies `worker/room.ts` instead of running the
  Worker under Miniflare; a real-socket session ran on Node 24 only
  (`engines` says >=22); an agent or phone remote that joins before the
  presenter's socket is open is not counted (hello is not resent);
  `docwalk-mcp` is not on npm yet.
- Markdown: decision 42 wants the sanitizer corpus on three engines, the
  browser test project runs Chromium only; a footnote list pushed to a
  continuation page stays there; anchors cover top-level headings only.
- Comments: no markers inside scaled slides (the slide chip stands in); no
  tombstones, so a deleted comment can return from an older link or
  sidecar; swapping two diagrams under one heading orphans their node
  comments; no author names.
- Canvas: axe excludes two upstream Excalidraw controls by selector; the
  Library sidebar links to libraries.excalidraw.com on click; stored
  sketches are never pruned; cylinders convert to rectangles.
- Monaco: the cursor line is not carried across an editor switch (the
  decision 4 contract has no initial cursor); Monarch colours 4-space list
  continuations as code; the chunk is 831 kB gzip; the palette does not
  offer the editor choice.
- PWA: F6 to the update toast is unverified; no `file_handlers` and no
  periodic update check.
- CI and quality: mutation survivors are reported, not fixed (no unit test
  feeds `src/share/fragment.ts` a fragment its schema rejects); Lighthouse
  SEO is 0.82 and unbudgeted. "Editing the source … notes in the gutter"
  (`e2e/app.spec.ts`) failed once on WebKit under load and never again in
  40 runs; one lead is that `App.tsx` diagnostics fall back to line 1
  (`?? 1`) for a slide from a stale deck. The presenter axe test's 90 s
  budget assumes CI is about twice as slow as a local run; it was not
  measured on CI.
- Speaker notes (decision 79): a comment above the first heading opens a
  slide of its own, blank and titled by its address in the presenter list
  (a `markdownlint-disable` line above `# Title` does it); the notes go to
  the next slide, the blank slide stays. Notes are not exported (no
  handout, no notes in PDF), show Markdown as plain text, and travel in
  the document text, so a share link or a remote room carries them.
- Countdown, pacing bar and wake lock (decision 80): the target cannot change
  while it runs (Reset, then a new value, restarts the clock), and the
  countdown ends when the presenter window closes. The real wake lock is
  tested in Chromium only; Firefox and WebKit run the tests for a missing or
  refusing API. A phone remote or follow link shows neither the clock nor
  the bar.
- Accessibility judgement to confirm: in the fill frame (decision 77) the
  deck's focus ring hides with the idle controls, read as meeting WCAG
  2.4.7 because it shows whenever they do. A stricter reading keeps it
  visible at all times. In Firefox the deck's focus stays invisible after
  Present's click until Tab moves it.
- Layout: with the comments panel open at 1440 px the deck pane is about
  500 px and the annotation toolbar wraps to two rows; on a phone an
  expanded file panel leaves the outline about one row inside the 40dvh
  sidebar; overview thumbnails are clones and repeat the slides' ids.
- Code colours (decision 76): a grammar that loads after the 5 s timeout
  colours nothing until the next rebuild; the default view's first load
  is 977 kB of the 1 MB limit, and Shiki's precompiled grammars with its
  raw engine (experimental upstream) would save an estimated 18 kB; a language
  outside the 24 stays plain, and Markdown bold and italic in a code block
  get no colour (the theme marks them with weight only).
- While presenting in real fullscreen, Escape with a dialog open closes the
  dialog and leaves fullscreen (browsers keep the key); presenting goes on
  windowed until a second Escape.
- Presenting controls (decision 75): check on a real iPhone, in Safari and
  from the Home Screen, since Playwright's WebKit emulates no notch or
  safe-area insets (Chromium's CDP override stands in for the tests).
- Aspect-adaptive slides (decision 77): a slide sized to the screen's
  aspect would leave no bars at all on a 16:10 or 4:3 screen, but its page
  breaks would depend on the device, and followers, the presenter window
  and links address slides as `<section-id>/<n>`. It needs one shared
  aspect per talk (the presenter's, sent to followers) before it can be
  considered.
- Fill frame on follower screens (decision 77): a follow screen still shows
  the card on the dark stage and keeps its bar; a room's second screen
  would gain the same room the presenter's did.

## Next up

Features from [`docs/feature-gaps.md`](./docs/feature-gaps.md), in this
order unless the owner picks differently. The first three give the most for
the least work. Each starts with a decision row, then failing tests, then
code.

1. A focus view for code blocks, images and wide tables, with
   click-to-highlight code lines (reuses the diagram focus).
2. Laser, strokes and diagram focus mirrored to followers and the presenter
   window, inside the signed, encrypted room messages (decisions 68, 73).
3. Full-text search in the command palette.
4. Picking which sections to present, kept in the URL.
5. Saved annotations, included in PDF and PNG exports.
6. Math and emoji shortcodes, which GitHub renders natively.
7. A step-through tour of a Mermaid diagram's nodes and paths.
8. A blank whiteboard, rectangle and ellipse shapes, stylus detection.

## Later

- More locales after Turkish through Weblate; RTL with CSS logical
  properties.
