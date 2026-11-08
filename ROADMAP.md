# Roadmap: docwalk

Dated 2026-11-09. Update this file when an item ships or a deferred item's
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
- Done 2026-11-08: the v1 gaps in the decision list (rows 82 to 85):
  remote control recorded as part of v1 (refines 8); the app's slide
  overview recorded as replacing reveal.js's (refines 3, 17, 27); the
  Lighthouse floors recorded (refines 43); `e2e/aria-snapshots.spec.ts`
  pins the accessible tree of the edit, document, present and presenter
  views, the overview, the palette and two dialogs on three engines. No
  screenshot assertion: PNG baselines are per engine and operating system,
  and nothing here can make Ubuntu ones (85).
- Done 2026-11-08: focus view for code blocks, tables and loaded images
  (decision 87): the diagram's view reused, click or Enter opens it, code
  lines can be marked and cleared, and an open view closes on a rebuild or a
  slide change. `e2e/focus-view.spec.ts` and
  `src/deck/focusTargets.browser.test.ts` cover it on Chromium.
- Done 2026-11-08: the presenter's laser (its own and a phone's), pen and
  arrow strokes, erase, undo, redo, clear, slide changes and the diagram
  focus view mirrored to followers, signed like the state; the laser and
  marks also reach the presenter window over the bridge (decision 88).
  `src/annotate/mirrorFeed.test.ts`, `mirrorStore.test.ts`,
  `mirrorView.browser.test.ts`, `src/remote/remote.browser.test.ts` and
  `e2e/mirror.spec.ts` cover it on Chromium; Firefox and WebKit run in the
  fork's CI.
- Done 2026-11-09: choosing the sections to present (decision 100): a
  dialog from the sidebar, the palette or More actions, kept in the link as
  `?sections=`; the deck, outline, palette, overview, presenter list and
  exports hold the chosen sections, and document mode and the editor keep
  the whole file. `e2e/sections.spec.ts` covers it (19 tests on Chromium).

Still open in v1:

- Decision 43's 1.5 s open budget does not hold. Re-measured 2026-11-08 on
  the current build with `e2e/perf.spec.ts` (809-line fixture, 14 diagrams,
  Chromium 156 as Playwright's full Chrome, AMD Ryzen 7 7800X3D, 31 GB,
  Windows 11, `--workers=1`): 7 runs gave 1731, 1751, 1773,
  1774, 1786, 1788 and 1973 ms, median 1774 ms and worst 1973 ms. The CI
  runner (run 42501338111, single sample) took 2559 ms. Before ELK left the
  bundle the spec read about 2.5 s, so the build improved and is still
  about 18 % over on this machine, 70 % over on CI. The other budgets hold:
  repaginate had a median of 214 ms and a worst of 230 ms against 300 ms (CI
  325 ms, one sample, over), and the default view's first load is 979 kB
  gzip against the 1 MB limit. The spec warns above the budget and fails
  above three times it; the threshold is unchanged. A perf pass on the open
  path is the next step.

## v2: workspace and agents

Done 2026-11-05 (decisions 57 to 59, details 66 and 67): browser workspace in
OPFS with templates and zip import/export; local folders with save on
request, reload on change and conflict prompts; `docwalk-mcp` with "Allow
agent edits", whose writes land as edits of the open file (autosaved in the
browser workspace, unsaved until Save in a local folder). Also done that
day: Monaco as an optional editor (53), canvas mode (54, 64) and comments
(55, 65).

Done 2026-11-09 (decisions 89 to 93): the browser workspace follows edits
from another tab and asks before it writes over a file another tab changed or
deleted; without `FileSystemObserver` a local folder's tree is listed every
3 s; the browser is asked to keep the workspace after the first save; comments
and sketches follow a rename or delete past the 5000-entry cap; Save refuses
to write over a local file it cannot read, and the zip export refuses to leave
out files past the cap. `e2e/workspace.spec.ts` passes on Chromium and Firefox
here. Playwright's WebKit on Windows leaves OPFS writes empty, so 9 of its 15
tests fail on that engine on the base branch too; WebKit rests on the fork's
CI.

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
  have all run on GitHub. zizmor runs with `--offline` and no token, so its
  online audits stay off. All seven pinned actions' tags matched their SHAs
  on 2026-11-09. `pnpm/action-setup` v6.1.1 dates from 2026-11-03: decide
  whether the 7-day age rule covers actions.
- A real `showDirectoryPicker` folder on a real disk in desktop Chrome:
  handle kept in IndexedDB, permission asked again on return. Every test
  uses an OPFS handle in its place.
- `vite-plugin-pwa` stays out while `trustPolicy: no-downgrade` rejects
  workbox-build; the in-house plugin is the workaround, not a policy change.

Later rounds:

- Workspace: no fallback for Safari before 26 (no `createWritable`) or
  private windows; the panel stays hidden there (decision 89). A rename or
  move made on disk, outside docwalk, does not carry comments and sketches:
  a file's identity is its folder and path (65), and a guess from size, time
  or text would hand one file's annotations to another (decision 92). A
  rename in another tab reads as a deletion in this one (decision 90).
  Without `FileSystemObserver` a change can show up to about 3 s late.
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
- CI and quality: mutation survivors are reported, not fixed, except in
  `src/share/fragment.ts`, whose tests now hold real documents that only its
  schema refuses (65 to 68 killed on 2026-11-09; the 8 left are equivalent
  mutants, such as padding that `atob` does not need); Lighthouse
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
- Full-text slide search (decision 81): diagram labels are not searched, a
  query is one contiguous phrase (no fuzzy or any-order matching), and in the
  Turkish UI `gec` does not find `geç`, because the collation that the title
  filter always used treats ç, ğ, ö, ş and ü as letters of their own. Ten
  text hits show at most.
- Focus view (decision 87): checked on Chromium only; Firefox and WebKit run
  in the fork's CI. The diagram view still stays open over a rebuild and a
  slide change while the other three close (its own test says so); line
  marks are not kept between openings; code has no line numbers; a table
  fitted at the 0.75 floor still scrolls sideways; a double-click that
  selects a word in code or a table opens the view on its first click; the
  view is not in any export, and only the diagram view is mirrored to
  followers (decision 88).
- Mirroring (decision 88), known gaps: a follower that paginates a section
  differently shows marks only on a page with the presenter's address; a
  slide with over 200 strokes is mirrored with the newest 200; a relay that
  drops a `focus-close` leaves a follower's view open until it presses
  Escape or the next resync; a follower's own close of the mirrored view
  holds until the presenter opens another diagram; a phone remote that
  moves the slide while a diagram view is open leaves that view open on
  both screens; a follower that joins within 2 s of the last resync waits
  for the next one.
- Choosing sections (decision 100): the share link and the follow link
  leave out `?sections=` (the owner decides whether the share link should
  carry it); a follower counts every slide; the presenter window still
  builds previews for skipped sections.
- Shortcut hints: on Apple platforms `ModShortcut` draws the command glyph
  as an `aria-hidden` icon, so the palette button's accessible name ends in
  "K" with no modifier (the ARIA snapshot on WebKit shows it). A screen
  reader user on a Mac hears the key without knowing it needs Command.
  Judgement call, not changed here.
- `pnpm size` exits 1 without output on Windows: `tooling/size-check.ts`
  runs `size-limit` through `execFileSync` without a shell, which cannot
  start the `.cmd` shim. `pnpm exec size-limit` works there (409 kB for
  the app shell on 2026-11-08).
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
order unless the owner picks differently. The first two give the most for
the least work. Each starts with a decision row, then failing tests, then
code.

1. The code, table and image focus views, with their line marks, mirrored
   to followers inside the signed, encrypted room messages. The laser,
   strokes and the diagram view already are (decisions 87, 88).
2. Saved annotations, included in PDF and PNG exports.
3. Math and emoji shortcodes, which GitHub renders natively.
4. A step-through tour of a Mermaid diagram's nodes and paths.
5. A blank whiteboard, rectangle and ellipse shapes, stylus detection.

## Later

- More locales after Turkish through Weblate; RTL with CSS logical
  properties.
