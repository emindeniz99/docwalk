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
- Done 2026-11-09: saved marks (decision 105): the presenter's pen and
  arrow marks stay in this browser per document and slide, come back on
  reload, and the PDF, HTML and PNG exports draw them unless Include marks is
  off; More actions or the palette deletes them. Stored records are checked
  for size before parsing. `e2e/saved-marks.spec.ts` covers it (3 tests on
  Chromium).
- Done 2026-11-09: Markdown fidelity (decision 107): each page of a split
  slide shows the footnotes its own text cites; headings inside quotes,
  alerts and list items get their GitHub anchor; a preamble of comments
  above the first heading opens no slide and its notes go to the first.
- Done 2026-11-09: the code, table and image focus views mirrored to
  followers with their zoom, scroll and code line marks, inside the signed,
  sealed mirror messages (decision 106). Code blocks, images and diagrams are
  numbered across their section, so a follower with other page breaks opens
  the same block or nothing. `e2e/mirror-focus.spec.ts` covers it (6 tests
  on Chromium).
- Done 2026-11-09: choosing the sections to present (decision 100): a
  dialog from the sidebar, the palette or More actions, kept in the link as
  `?sections=`; the deck, outline, palette, overview, presenter list and
  exports hold the chosen sections, and document mode and the editor keep
  the whole file. `e2e/sections.spec.ts` covers it (19 tests on Chromium).
- Done 2026-11-09: the diagram tour (decision 109, proposed): in the diagram
  focus view, T or the Tour button steps through a flowchart, class, state
  or ER diagram node by node along its edges, fading what is not linked and
  naming what is; followers see the same path. `e2e/diagram-tour.spec.ts`
  and `e2e/diagram-tour-mirror.spec.ts` cover it (5 tests on Chromium).
- Done 2026-11-09: math and emoji shortcodes (decision 101): `$…$`,
  ``$`…`$``, `$$…$$`, ` ```math ` fences and `:rocket:` render as on GitHub.
  Temml builds each formula in a Web Worker, stopped after 500 ms; the page
  rebuilds its tree from data through an allowlist and holds lengths to
  4 em. `e2e/math.spec.ts` covers it (6 tests on Chromium).
- Done 2026-11-09: a whiteboard per section, rectangle and ellipse tools,
  and stylus input (decision 110, proposed): W, the toolbar or the palette
  opens a blank page with its own marks, mirrored to followers and the
  presenter window, saved with the document's marks and printed after its
  section; R and C draw shapes; a pen draws without choosing a tool, and
  once a pen has touched the screen fingers change slides.
  `e2e/whiteboard.spec.ts`, `e2e/stylus.spec.ts` and `e2e/shapes.spec.ts`
  cover it (15 tests on Chromium).
- Done 2026-11-09: speaker notes in print (decision 114, proposed): Export ›
  Print with speaker notes puts each chosen section's notes on a page after
  its last slide; the HTML file and PNG images never carry notes.
  `e2e/export.spec.ts` covers it.

Still open in v1:

- Decision 43's 1.5 s open budget does not hold. On 2026-11-08 a Windows
  desktop (Ryzen 7 7800X3D, Chromium 156, `--workers=1`) gave a median of
  1774 ms over 7 runs of `e2e/perf.spec.ts` (809-line fixture, 14 diagrams)
  and the CI runner 2559 ms. A perf pass on 2026-11-09 moved Shiki into a
  Web Worker (row 76) and made pagination keep the blocks two tries share.
  On a shared 4-core Linux machine (Chromium 1243, load average 2 to 3), 14
  interleaved runs each gave a median of 2443 ms against 2645 ms before.
  Mermaid's renders take about 1150 ms of that (two parses per diagram and
  DOMPurify, rules 4 and 5), start-up before the document arrives about
  480 ms, pagination 180 ms and the overflow pass 80 ms. At the same ratio the
  Windows desktop would read about 1640 ms, still over, and CI more. Reaching
  1.5 s on CI needs less Mermaid work before measuring, which rule 4 does not
  allow, or a faster Mermaid. Repaginate read 317 to 379 ms on that machine
  against 300 ms (214 ms median on the desktop). The first load is 993 kB of
  1 MB gzip. The spec warns above the budget and fails above three times it;
  the threshold is unchanged.

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

Done 2026-11-09 (decisions 94 to 97): comment count markers sit beside
commented headings on the scaled slide, at least 24 px at any scale;
deleted comments leave tombstones, so an older link, sidecar or tab does
not bring them back; node comments follow their diagram when diagrams
trade places; a new comment can carry a display name kept in this
browser. `e2e/comments.spec.ts` passes 11 of 11 on Chromium.

Done 2026-11-09 (decision 102): a switch of editor keeps the cursor line;
the palette offers the other editor; a pick in one tab applies in the
others; Monaco's own Markdown grammar colours a list item's indented
paragraphs as text; Monaco's panels are Turkish for Turkish viewers.
`e2e/editor-choice.spec.ts` passes 10 of 10 on Chromium.

Done 2026-11-09 (decisions 98 and 99): canvas mode names Excalidraw's menu
and zoom buttons, so axe runs on it without exclusions; the Library hides
its Browse libraries link; a Saved sketches panel deletes stored sketches;
full storage and a missing `crypto.subtle` are reported as such. The
installed app opens Markdown files from the file manager (Chromium), checks
for a new version once an hour while visible and online, and F6 reaches the
update prompt; `pnpm size` starts size-limit through Node, so it runs on
Windows. `e2e/canvas.spec.ts` (7) and `e2e/pwa.spec.ts` (12) pass on
Chromium here.

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
  Worker under Miniflare; `e2e/mcp.spec.ts`, a real-socket session with the
  built bin, passed 3 of 3 on Node 22.23.4 on 2026-11-09 (the MCP unit tests
  20 of 20), but CI runs Node 24 only, so nothing holds `engines` (>=22) in
  place; a device that left is still counted (there is no goodbye), and an agent built before decision 111 stays uncounted after a presenter reload;
  `docwalk-mcp` is not on npm yet.
- Markdown (decision 107): raw HTML headings (`<h2>…</h2>`) and headings
  inside footnote definitions get no anchor; a heading's slug comes from its
  source text, so `## Foo <sup>beta</sup>` gives `foo-supbetasup` where
  GitHub would give `foo-beta`; GitHub's numbering of duplicate slugs across
  nested headings is read from its behaviour, not from a captured fixture.
- Saved marks (decision 105): marks do not follow a workspace rename or
  delete; two tabs on one document each keep what they loaded and the last
  save of a slide wins; marks travel in no share link, sidecar or zip; undo
  cannot remove a restored mark (the eraser and Clear can); on plain http,
  where the browser cannot hash, marks are neither saved nor exported, and
  comments stay "loading"; `markSvg.ts` repeats `mirrorView.ts`'s drawing.
- Comments (decisions 94 to 97): a tombstone list stops at 500, so a very
  old file can bring back a deletion older than the 500 newest; a node
  comment's `sig` describes the diagram when the comment was written, so
  after an edit a later swap is judged by position; the display name is
  not an identity (anyone can type any name) and needs the owner's
  approval (row 97); a long share link drops its tombstones before its
  comments.
- Canvas: the Library's Publish form remains (Excalidraw has no switch for
  it); stored sketches are deleted by hand from the Saved sketches panel,
  never pruned automatically; cylinders convert to rectangles; the Turkish
  strings have not been read by a native speaker.
- Monaco: its own text keeps the language it loaded with until a reload;
  the chunk is 833 kB gzip and stays whole, because the hover that shows
  notes pulls in most of what could be split (decision 102); list content
  offsets past 16 columns count as 16, and a tab ends a list item.
- PWA: the file launch is tested with a stand-in `launchQueue`; no real
  file-manager launch has been tried.
- CI and quality: mutation survivors are reported, not fixed, except in
  `src/share/fragment.ts`, whose tests now hold real documents that only its
  schema refuses (65 to 68 killed on 2026-11-09; the 8 left are equivalent
  mutants, such as padding that `atob` does not need); Lighthouse SEO has a
  0.95 floor since 2026-11-09 (decision 104). "Editing the source … notes in the gutter"
  (`e2e/app.spec.ts`) failed once on WebKit; on 2026-11-09 the stale-deck
  note on line 1 was fixed (cosmetic, not the cause) and the test waits for
  the ready deck, but it still fails if a rebuild takes over 5 s, which was
  not measured on WebKit. The presenter axe test's 90 s
  budget assumes CI is about twice as slow as a local run; it was not
  measured on CI.
- Speaker notes (decision 79): a comment-only part after the first slide
  (between two thematic breaks) still opens a blank slide. Only Print with
  speaker notes carries them out of the app (decision 114); they show
  Markdown as plain text and travel in the document text, so a share link
  or a remote room carries them. A print started during a rebuild can miss
  a renamed section's notes.
- Countdown, pacing bar and wake lock (decision 80): the target cannot change
  while it runs (Reset, then a new value, restarts the clock), and the
  countdown ends when the presenter window closes. The real wake lock is
  tested in Chromium only; Firefox and WebKit run the tests for a missing or
  refusing API. The phone remote shows the presenter window's countdown,
  read-only (decision 112, proposed); a follow link shows nothing, by
  design. The phone cannot start, pause or reset it, shows no pacing bar,
  and with two presenter windows shows whichever spoke last. Chrome's
  throttling of a window hidden for over five minutes may starve the
  window's 2 s heartbeat and blank the phone's clock; nobody has checked
  this by hand yet.
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
  view is not in any export, and the presenter window shows no focus view
  (decisions 88 and 106). Clear in the code view disables itself while
  focused, so focus falls to the page and Escape no longer closes the view.
- Mirrored focus views (decision 106): a table split differently on two
  screens can open a different part of it on the follower; a follower that
  has not loaded the image opens nothing.
- Mirroring (decision 88), known gaps: a follower that paginates a section
  differently shows marks only on a page with the presenter's address; a
  slide with over 200 strokes is mirrored with the newest 200; a relay that
  drops a `focus-close` leaves a follower's view open until it presses
  Escape or the next resync; a follower's own close of the mirrored view
  holds until the presenter opens another diagram; a phone remote that
  moves the slide while a diagram view is open leaves that view open on
  both screens; a follower that joins inside the resync gap waits for the
  next resync: 2 s, longer after a costly one (about 7.6 s for a slide at
  the receiver's limits). Decision 103 (2026-11-09) fixed the review's
  findings: a resync opens with `keep` instead of clearing, a stroke in
  progress resyncs only as far as it was sent, and hellos are coalesced.
- Choosing sections (decision 100): the share link and the follow link
  leave out `?sections=` (the owner decides whether the share link should
  carry it); a follower counts every slide; the presenter window still
  builds previews for skipped sections.
- Links during a rebuild: a link followed while a rebuild is in flight (the
  250 ms after an edit) is overridden by the editor's cursor-follow in the same
  pass. Letting the hash win needs a decision row (`useUrlSync` and
  `followCursor` in `App.tsx`); the owner decides.
- Shortcut hints: on Apple platforms `ModShortcut` draws the command glyph
  as an `aria-hidden` icon, so the palette button's accessible name ends in
  "K" with no modifier (the ARIA snapshot on WebKit shows it). A screen
  reader user on a Mac hears the key without knowing it needs Command.
  Judgement call, not changed here.
- Accessibility judgement to confirm: in the fill frame (decision 77) the
  deck's focus ring hides with the idle controls, read as meeting WCAG
  2.4.7 because it shows whenever they do. A stricter reading keeps it
  visible at all times. In Firefox the deck's focus stays invisible after
  Present's click until Tab moves it.
- Layout (decision 108): with the comments panel open and a window
  narrower than about 1264 px the annotation tool groups wrap again, with
  every control reachable; the diagram focus view copies the SVG with its
  ids, so they repeat while it is open; at 1280 px the app header takes two
  rows (113 px against 63 px at 1440).
- Code colours (decisions 76 and 115): a grammar that lands after the 5 s
  timeout colours its blocks in place within 60 s, but an open overview or
  focus view keeps its plain copy until reopened, and the presenter's previews
  stay plain until their next build; Shiki's precompiled grammars with its raw
  engine (experimental upstream) would save an estimated 18 kB of the first
  load; a language outside the 24 stays plain.
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
- Whiteboard (decision 110, proposed): one board per section, keyed by the
  section id, so renaming the heading leaves the board behind and a
  numbered or positional id (`demo-1`, `slide-N`) can move it to another
  section; a follower cannot close it; no highlighter or plain line on it;
  closing it keeps the pen that opening chose; a pen's eraser end does
  nothing; the first-pen notice shifts the page once. Apple Pencil on a
  real iPad (Scribble, hover, palm) is untested.
- Follow screens (decision 113, proposed): no Full screen button, no wake
  lock and no frame switch on the follow page; the frame follows what this
  browser chose in another docwalk tab.

## Next up

Every feature ranked in [`docs/feature-gaps.md`](./docs/feature-gaps.md)
for this round is built; the owner picks the next round. Each starts with a
decision row, then failing tests, then code.

## Later

- More locales after Turkish through Weblate; RTL with CSS logical
  properties.
