# Roadmap: docwalk

Dated 2026-11-11. Update this file when an item ships or a deferred item's
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
- Done 2026-11-09: the diagram tour (decision 109): in the diagram
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
  and stylus input (decision 110): W, the toolbar or the palette
  opens a blank page with its own marks, mirrored to followers and the
  presenter window, saved with the document's marks and printed after its
  section; R and C draw shapes; a pen draws without choosing a tool, and
  once a pen has touched the screen fingers change slides.
  `e2e/whiteboard.spec.ts`, `e2e/stylus.spec.ts` and `e2e/shapes.spec.ts`
  cover it (15 tests on Chromium).
- Done 2026-11-09: speaker notes in print (decision 114): Export ›
  Print with speaker notes puts each chosen section's notes on a page after
  its last slide; the HTML file and PNG images never carry notes.
  `e2e/export.spec.ts` covers it.
- Done 2026-11-09: the security review of PR #5 (decisions 116 to 121):
  palette text search folds each slide once and runs `indexOf` per
  keystroke; the countdown is signed and the remote link carries the
  public state key; only a signed state makes a client say hello again; a
  link or file asks before it deletes comments here; a `?src=` document's
  comments and marks key by origin and path, moved once from the old key;
  a case-only rename picks a free temporary name; the notes panel says
  notes are not private. Rows 97, 98 and 109 to 115 were accepted by the
  owner with the merge of PR #5.
- Done 2026-11-09: a `?src=` document's sketches key by origin and path
  like its comments and marks, and move once from the old key on the next
  opening of the sketch dialog (decision 122).
- Done 2026-11-09: the palette filters slide titles by folding each title
  once per deck and running `indexOf`, as its text search does: a
  keystroke over a 2 MB heading makes 13 collator calls instead of 6.3
  million (decision 123).

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
  against 300 ms (214 ms median on the desktop). The first load is 993 kB gzip
  (decision 124: warn above 3 MB, fail above 5 MB). The spec warns above the budget and fails above three times it;
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

Done 2026-11-11 (decisions 125 and 126): the simplification pass, with nothing
a user sees changed and no test assertion touched. `src/App.tsx` went from
1,466 to 891 lines; its jobs moved into one hook each in their area's folder.
The follower mirror draws pen and arrow marks with `markSvg.ts` (`mirrorView.ts`
251 to 188 lines). Three unused definitions went, and 131 symbols only their
own file uses lost `export`. The health check no longer loads the sign-in
chunk. App shell 430.7 to 432.1 kB gzip; first load 994 kB, 84 files, before
and after.

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
- CI, Lighthouse, zizmor, the Pages deploy and the nightly Stryker run
  have all run on GitHub. zizmor runs with `--offline` and no token, so its
  online audits stay off. All seven pinned actions' tags matched their SHAs
  on 2026-11-09. The 7-day age rule covers actions too (owner, 2026-11-13;
  CONTRIBUTING, "GitHub Actions").
- A real `showDirectoryPicker` folder on a real disk in desktop Chrome:
  handle kept in IndexedDB, permission asked again on return. Every test
  uses an OPFS handle in its place.
- `vite-plugin-pwa` stays out while `trustPolicy: no-downgrade` rejects
  workbox-build; the in-house plugin is the workaround, not a policy change.

Later rounds:

- CI speed, on the same runners (no extra jobs or sharding: the owner wants
  no added runner cost). Done on 2026-11-14: tests that measure time carry
  the `@timing` tag and run alone on one worker after the rest (the frame-gap
  test had failed at 632 ms of its 500 under a third worker), and the e2e
  workers are set per engine in `ci.yml`. Measured over three runs each, the
  main step took Chromium about 15 min with two workers and 11 with three,
  Firefox 16 and 13, WebKit about 24 and 25 (20 to 30 from run to run), so
  WebKit keeps two. On 2026-11-14 the 10 slowest WebKit tests took 29 to
  35 s each in a full run, and the median test 13 s. One cost runs through
  most of them: the 800-line sample takes 6 to 9 s to render on WebKit, and
  many tests then replace it with a short document of their own. Five of the
  ten now open their own document by `#doc=` link (`docLink` in
  `e2e/helpers.ts`), and the wake-lock test presents twice on one load
  instead of loading the sample again. Medians of three runs each, each test
  alone on WebKit: saved marks 23.9 to 9.0 s, cursor follow 10.1 to 3.2,
  phone countdown 26.6 to 19.7, whiteboard 15.5 to 11.5, wake lock 12.1 to
  8.9, agent long doc 23.3 to 21.7 (its Mermaid chunks now load during the
  long write instead). Left as they were: the presenter-window audit (axe
  checks the sample's previews), the display-name comment test (its reload
  needs the paste kept as the draft) and two workspace tests (a link in the
  address bar would send them through the workspace's replace guard). On
  2026-11-16 a second round moved 100 more tests in 24 spec files to
  `docLink` (97 run on WebKit, three are Chromium's pen tests). Alone on
  WebKit with one worker those 97 took 400 s instead of 728 (medians of three
  interleaved runs); markdown, focus-view, pacing, speaker-notes,
  aria-snapshots, comments and tasklist saved 23 to 42 s each. The whole
  WebKit suite with two workers took 20.3 min instead of 23.0 (one run each
  on a shared machine, busier during the second). Still on the sample or the
  paste, each for a reason: tests about an edit, the draft or a reload of
  the paste (`app`'s source edit, both `share` tests, `sections` editing,
  `i18n`'s draft, three comment tests that reload "/", the comment diagram
  swap, the Monaco switch of typed text, the agent write gate,
  `workspace`); `math`'s chunk test, whose negative case is the sample's
  timestamps and code; two tests that wait for a slide address in the URL,
  which a `#doc=` page never writes (`deck`'s presenter overflow note, the
  palette's hostile text); `subpath`, which runs on Chromium alone under
  `/docwalk/`; and `highlight`'s three older tests, whose first one failed on
  WebKit by link until decision 173 fixed the code colours and added a link
  test of its own.
- Remote links made before decision 117 carry no `p=` (the presenter's
  public state key), so a phone or agent that joined with one shows no
  countdown and never says hello again (118) until the presenter shares a new
  link. Nothing in code can repair an old link; the presenter window could
  say so when such a remote joins.
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
  a remote link made before decision 117 has no state key, so its phone
  shows no countdown and never says hello again (decision 118);
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
  not an identity (anyone can type any name); a long share link drops its
  tombstones before its comments; a link's or file's tombstones for
  comments here wait for the user's Delete and are lost if the notice is
  dismissed (decision 119); two `?src=` documents that differ only in
  their query share comments, marks and sketches (decisions 120 and 122).
- Canvas: the Library's Publish form remains (Excalidraw has no switch for
  it); sketches stored under a `?src=` document's old key stay until that
  document's sketch dialog opens again (decision 122); stored sketches are deleted by hand from the Saved sketches panel,
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
  mutants, such as padding that `atob` does not need); on 2026-11-14 tests
  killed survivors in three more modules (one file at a time, scores before
  and after): `src/sectioning/sectionize.ts` 94.83 to 98.52, `src/url/state.ts`
  86.38 to 92.02, `src/shell/slideSearch.ts` 76.45 to 90.35 (93.44 in the run
  before the last test; its caches are module-wide, so a mutant's verdict can
  depend on which mutants ran before it, and two runs of the same tests can
  differ by a few points). The mutants left are equivalent: caches and their
  limits, guards that the id regex, the parser round trip or `indexOf` repeat
  one step later, `position?.` (the parser always sets a position), and the
  fold's `\s+` and Turkish lower-casing branch. Not fixed, and a different
  decision from the old title filter: "oﬃce" now matches "ffi", which React
  Aria's window did not. Lighthouse SEO has a
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
  Markdown as plain text and are not private: the document text carries
  them in every share link and room (decision 121). A print started during a rebuild can miss
  a renamed section's notes.
- Countdown, pacing bar and wake lock (decision 80): the target cannot change
  while it runs (Reset, then a new value, restarts the clock), and the
  countdown ends when the presenter window closes. The real wake lock is
  tested in Chromium only; Firefox and WebKit run the tests for a missing or
  refusing API. The phone remote shows the presenter window's countdown,
  read-only (decision 112), and only when the presenter signed it
  (decision 117); a follow link shows nothing, by
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
  focused, so focus falls to the page and Escape no longer closes the view. A
  blocked image in the table view keeps its load button, a tab stop that
  loads nothing there (read from `cleanCopy` in `src/deck/focus.ts`, not
  tested); the code view drops that button since 2026-11-13.
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
  windowed until a second Escape. The owner keeps this (2026-11-13): Chromium's
  Keyboard Lock would fix it but makes users hold Escape to leave fullscreen,
  and Firefox and Safari lack it.
- Presenting controls (decision 75): check on a real iPhone, in Safari and
  from the Home Screen, since Playwright's WebKit emulates no notch or
  safe-area insets (Chromium's CDP override stands in for the tests).
- Aspect-adaptive slides (decision 77): a slide sized to the screen's
  aspect would leave no bars at all on a 16:10 or 4:3 screen, but its page
  breaks would depend on the device, and followers, the presenter window
  and links address slides as `<section-id>/<n>`. It needs one shared
  aspect per talk (the presenter's, sent to followers) before it can be
  considered.
- Whiteboard (decision 110): one board per section, keyed by the
  section id, so renaming the heading leaves the board behind and a
  numbered or positional id (`demo-1`, `slide-N`) can move it to another
  section; a follower cannot close it; no highlighter or plain line on it;
  closing it keeps the pen that opening chose; a pen's eraser end does
  nothing; the first-pen notice shifts the page once. Apple Pencil on a
  real iPad (Scribble, hover, palm) is untested.
- Follow screens (decision 113): no Full screen button, no wake
  lock and no frame switch on the follow page; the frame follows what this
  browser chose in another docwalk tab.

- Simplification pass (decisions 125 and 126), left as found: `findText` in
  `src/shell/slideSearch.ts` is called only by its own test; `sameList` in
  `mirrorFeed.ts` and `mirrorStore.ts` and `sectionOf` in `annotate/board.ts`
  and `deck/focusTargets.ts` look alike and differ in an edge case; unused CSS
  rules were not looked for; `shell/appCommands.ts` takes about 27 values from
  App to build the palette and More menu lists. First-load candidates measured
  and left are in row 126. On a 4-core machine with two Playwright workers,
  `e2e/mirror.spec.ts:100` and `e2e/diagram-tour-mirror.spec.ts:104` failed once
  on `main` before the pass and pass alone with `--workers=1`: a race to find
  (CONTRIBUTING, Picking up work 5).

- Pan and zoom in the focus views (decisions 127 and 128), built and tested
  with synthetic events in Chromium only. Owed, by hand: a Mac trackpad
  (two-finger scroll pans, a pinch feels proportional; the factor is
  `exp(-deltaY * 0.01)` with 10 px per event at most) in Chrome, Firefox and
  Safari; whether Safari sends both `gesturechange` and `ctrlKey` wheel events
  for one pinch, which would zoom twice; an iPad and a phone. On a touch screen
  the code and table views allow native panning (`touch-action: pan-x pan-y`),
  and a browser that takes two moving fingers for a pan sends `pointercancel`,
  which would end the pinch after a few moves: if so, those views need
  `touch-action: none` and their own one-finger scroll. iOS gesture events may
  carry no `clientX`, and the zoom then centres on the top left. A code or
  table view that starts with no room to scroll drifts a few pixels under the
  pointer until it can scroll. The app shell grew 0.9 kB (433.0 kB gzip).

- Focus views in the document view (decision 129): when the view closes
  because the document is rendered again or the reader leaves the document
  view, keyboard focus lands on `<body>`, not on a block (nothing stays inert,
  and Tab and the shortcuts work); the built app's test opens a diagram only,
  the other kinds rest on browser tests; a `<summary>` or a blocked image's
  placeholder inside a table does its own action and opens the table view too,
  as on a slide; `e2e/document-mode.spec.ts` ran on Chromium here, Firefox and
  WebKit in the fork's CI.

- Presenting bar and hint on narrow screens (decisions 133 and 134, accepted
  by the owner on 2026-11-13):
  under 1000 px of pane width the bar keeps one row (menu for four tools, icon
  Exit, no address). While shown it covers the slide's title on a phone; if
  that bothers on a real iPhone, the owner's fallback is the bar at the bottom
  edge. The width is read from the deck pane, not the bar's
  head as row 133 says, because a container cannot change its own padding.
  Chromium with touch emulation only: WebKit, Firefox, a real iPhone and its
  safe-area insets are untested, and iOS fonts may set the counter wider (21 px
  spare at 667 px with three digits). A talk of only full slides never shows
  the hint. DESIGN.md still describes the More tools menu for the edit preview
  only. For decision 135 the owner chose "taşma uyarısı" (2026-11-13); the
  message file, the glossary row and the e2e check use it now. The hint
  counts text that is `visibility: hidden` as content, which keeps it off
  reveal.js fragments not yet shown; a slide change during its 5 s can leave
  it over the next slide's content; with the whiteboard open it is measured
  against the slide under the board. On touch the tooltip never opens, so the
  icon Exit shows no Esc hint there. With Exit's tooltip open, Escape exits
  through Exit's own action and focus lands on the deck.

## Next up

### 1. Map mode: the whole document on one zoomable canvas (decision 136)

The owner's idea (2026-11-09), designed with the owner on 2026-11-13: besides
slides and the one-column document view, a "Map" view (Turkish "Harita") shows
every section on one large canvas, the way Prezi does. You zoom out to see the
whole document and in to read a section; presenting moves the camera from
section to section. Decision 136 holds the settled design; build it from there.
A large feature: plan it as weeks, built in the steps below, each on its own
branch with a failing test first.

Settled (decision 136):

- **Layout from the headings only:** one column per `##` section, its `###`
  parts stacked inside. No new Markdown syntax (rule 1).
- **Frames grow with their content.** No pagination; a block taller than the
  screen opens in the focus view (decision 129's wiring, `src/deck/focusWiring.ts`).
- **Route and roaming:** arrow keys follow document order with a smooth camera
  move (instant under `prefers-reduced-motion`); mouse and trackpad roam with
  decision 127's pan and zoom; one key zooms out to the whole map.
- **Followers** follow the presenter's section by default, may roam, and have
  one key back to the presenter. Use the signed room messages (73, 88, 103);
  a section address (rule 7), not a camera position, is what is sent.
- **First version:** reading and presenting only. Not in it: the pen on the
  canvas, dragging frames, export. Those are later rows.
- **Name:** "Map" tab beside Edit and Document; not "Canvas" (decision 54) or
  "Overview".

Suggested steps:

1. Done 2026-11-16 (decisions 139 to 141): `src/map/layout.ts`. `mapPlan`
   sections the document at its own level `L` and at `L + 1`, with the deck's
   cover and with every heading above `L` kept as a frame; `mapColumns` opens a
   column at each heading at `L` or above and stacks the rest; `placeFrames`
   turns measured heights into rectangles (1280 wide, at least 720 tall, gaps
   64 and 192). Nothing uses it yet. The sample document gives 23 columns and
   40 frames. Rows 139 to 141 are the lead's reading of 136 and wait for the
   owner. For step 2: `MapFrame` carries id, title and depth only, so the view
   joins back to the plan's sections by id; frames not yet measured are 720
   tall, so later frames in a column move as heights arrive. For step 3: part
   ids and part contents differ between the deck's plan and the map's (`## A`,
   `### X`, a thematic break: the deck has `a, a-part-2`, the map `a, x,
   x-part-2`), so the address mapping must handle parts; a document with
   headings but no slide level keeps the deck's plan.
2. Done 2026-11-16 (decisions 142 to 144): "Map" ("Harita") is a third view
   beside Edit and Document, in the link as `view=map`, in a lazy chunk the
   first load never requests. `src/map/frames.ts` draws one section per frame
   with the slides' pipeline and reports heights; `src/map/camera.ts` is the
   camera as pure functions; `src/map/MapView.tsx` places the frames on one
   layer and moves it: a wheel pans, Ctrl/Cmd + wheel and a pinch zoom, one
   finger pans, a mouse drag on empty map pans. Diagrams draw only near the
   view. A click or Enter on a block opens the focus view (the part of step 4
   its marks promised). Rows 142 to 144 are the lead's reading and wait for
   the owner. Left open, for the owner or a later step:
   - A wide table or a long code line in a frame is not scrolled in place:
     the map takes every wheel and touch. It is read in the focus view or with
     the keyboard.
   - Zoomed all the way out, the map is not centred and can hang past an edge;
     step 3's zoom-out key centres it.
   - In Turkish at 1440 px the header takes two rows with three view choices
     (143). On a phone the choices are icons.
   - A frame with no heading (content above the first heading, a document with
     no headings) has no accessible name. Diagrams keep Mermaid's natural size
     and are not fitted as on a slide.
   - Fixed in step 3 (146): when the diagram code failed to load, the figure
     stayed empty with no note in the deck, the document view and the map.
   - Chromium only for touch and gestures: real trackpads, Safari's gesture
     events, an iPad and Firefox's wheel are untested. A tap is told from a pan
     by 10 px of movement.
   - For step 3: `MapView` has no way in from outside to move the camera; frame
     ids at `L + 1` and part ids are not deck addresses (140); the outline and
     the current slide come from the deck's plan, which follows the level
     override, and the map does not; arrow keys will meet focused scroll boxes
     and text; a smooth move must stop for wheel or pointer input and will
     trigger diagram drawing on the way.
3. Done 2026-11-16 (decisions 145 to 148): the route. The map has a current
   frame (`aria-current`, a ring about 3 screen px wide at every zoom, a polite
   status "Title, 2 of 40"). Arrow keys, Page keys, Space, Home and End walk the
   frames in document order (`src/map/route.ts`); `0` shows the whole map,
   centred, and `0` or Enter returns; `+` and `-` zoom. A click on a frame's
   heading or empty area goes there; while the whole map shows, any click in a
   frame does. A move takes 300 ms and jumps under reduced motion or in a
   hidden tab; any input stops it. The link keeps the slide address: the map
   reports the deck section that holds the frame's first line and the deck
   goes to that section's first page, so the outline, the status bar and Edit
   follow. Rows 145 to 148 are the lead's reading and wait for the owner. Left
   open, for the owner or a later step:
   - Chromium keeps a failed module request for the life of the page, so a
     diagram whose code did not load cannot be retried there; the note says to
     reload (146, 148). Presenter previews show that note per diagram where
     they showed an error state before.
   - A URL edited by hand to the section the deck is already on does not move
     the map; an outline entry, a palette result or a link does (148).
   - Right-to-left scroll boxes are not handled by the "can this box still
     scroll" rule for arrow keys.
   - Not verified: a real screen reader (the status wording, `aria-current` on
     a labelled section), real touch or trackpad input stopping a move, and
     the browser's `online` event (tested with a synthetic one).
   - Found on the way and fixed: under reduced motion the command palette's
     search box got no focus after focus had moved without a key or pointer
     (a screen reader, `focus()`); the reduced-motion rule now sets
     transitions to 0s (`src/styles.css`). React Aria's `runAfterTransition`
     loses a nested `transitioncancel`; worth reporting upstream.
   - For step 4: the laser draws in slide coordinates; a frame is a
     `.docwalk-slide`, but the layer is scaled and moved. For step 5: the map
     takes a `request` prop (`{ sectionId, seq }`) that always moves it, and
     `current`, which moves it only when the deck section changes.
4. Done 2026-11-16 (decision 149; the focus view is 144): the map's own laser
   (`src/map/laser.ts`). `L` on the pane or the palette switches it, Escape
   switches it off; a dot with the slides' fading trail is drawn over the pane
   in screen pixels. While it is on, a mouse, a pen or one finger points and
   does nothing else; two fingers, the wheel and the route keys work as
   before. Row 149 is the lead's reading and waits for the owner. Left open:
   - The Present button still opens the slides: a map is presented by sharing
     the window. Presenting the map full screen needs a row.
   - The phone remote's laser shows nothing on the map.
   - Not verified: a real pen, a real finger (long press, the finger left down
     after a pinch), Safari's gesture events with the laser on, and
     `cursor: none` in Firefox and WebKit.
5. Done 2026-11-16 (decision 150): followers on the map. The signed state
   carries an optional `view: "map"` while the presenter is on the map; a
   follow screen then shows the map on the frame of the presenter's section
   and moves with it, and shows the slides again when the presenter leaves the
   map. Any pan, zoom, route key or click on the follower's map starts a roam;
   a "Back to presenter" button or Escape ends it. Nothing is sent by a
   follower. Row 150 is the lead's reading and waits for the owner. Left open:
   - Only the section is sent, so a follower sits on the head frame of the
     presenter's column while the presenter reads a `###` frame of it, and
     stays behind when the presenter clicks a frame whose section the
     presenter's own choice of sections leaves out.
   - The laser, marks, whiteboard and the presenter's focus views are not
     shown on a follower's map (150).
   - The follow bar keeps saying "Following the presenter" during a roam: it
     is the connection's status. The roam is said by the map's status only.
   - A document too long for the room's link (the sample is) cannot be
     followed at all, with or without the map.
   - Not verified: Firefox and WebKit beyond CI, a real second device, and a
     phone or tablet as the follower.

Done means: a browser test per step, the end-to-end suite on Chromium,
Firefox and WebKit, axe on the map view, before and after screenshots of the
sample document on desktop and phone, and a hand check on a Mac trackpad and
an iPad recorded here.

Review of the merged PR #7 (2026-11-16): three reviewers read it for
correctness and fit to 136, for security, and for code nobody needs. No high
finding; CI green on all three engines.

**Who does what (owner, 2026-11-16).** Map mode stays with the contributor who
built it, working from their fork: everything under "Map: to do" below. The
lead works outside `src/map` meanwhile: the replay guard below, the "CI speed"
follow-up and "Next up" 2. So that decision numbers do not clash again, map
rows take 152 to 169 and the lead's rows 170 onward; a number left unused in a
range stays unused.

**Map: to do, in this order.** Each item is its own branch or series of
commits: a decision row first where a rule changes, then a failing test, then
code; the e2e suite on Chromium, Firefox and WebKit; a pull request from the
fork, merged with a merge commit.

1. Done 2026-11-25 (decisions 151 and 174; the lead's rows 152 to 155):
   - One column down the page (174): `placeFrames` stacks every frame at
     x = 0 in document order, a frame gap inside a section's group and a
     column gap between groups; `0` fits that column. Review found that a
     diagram drawn above the frame being read pushed it off screen (the
     sample's API heading went 400 px above the pane), so 155 keeps the
     current frame, or the first frame in view, in place when the frames are
     placed again.
   - The phone remote walks the map (152): while the map shows, a step goes
     to `MapView`'s `step()`, the arrow keys' move, `###` frames included; a
     step the map could not take (its chunk not loaded) turns the deck. An
     open code, table or image view closes only when the step moves.
   - Followers and links name the frame (153): `?frame=<id>` beside
     `view=map` and an optional signed `frame`, only for a frame that is not
     its column's head; a stale or foreign frame falls back to the section's.
     The presenter drops `frame` before the document link when a state is too
     large, and never sends a fallback after a later state.
   - "Present the map" (154): a 44 px button in the pane and a palette entry;
     the page root in full screen with the map pane alone, `view=map` kept,
     the screen awake. Exit, Escape or leaving full screen return to the map
     view on the same frame; an Escape for a dialog or the laser goes to it
     first. While presented a resize refits only until the presenter pans or
     zooms by hand.
   - Left open: an agent tool for next and previous (152 covers any
     control-key step, `docwalk-mcp` has none); the phone shows the deck's
     slide, not the frame; after a presenter reload with `?frame=`, followers
     may see the column head before the frame; switching view from the
     palette while the map is presented leaves full screen on, as on the
     slides. Not verified: Firefox's and WebKit's own Escape in full screen
     beyond CI, a real phone, tablet or second device.
2. Done 2026-11-25 (decision 156): `MapView` uses `isTextEntry`; one
   `TAP_SLOP` of 10 CSS px in `src/deck/tapSlop.ts` serves the map and the
   focus view, and both pan at 10 px or more.
3. Done 2026-11-25: `src/annotate/laserTrail.ts` holds the trail's duration,
   size, stroke and fade for the slides and the map; the map chunk still has
   no drauu.
4. Done 2026-11-25 (decision 157): no new diagram is queued while a frame
   shows narrower than 320 CSS px, so the whole map no longer asks for every
   diagram; the pointer move listener reads the pane's box only for a tracked
   finger or a drag. An active pinch is still re-applied on any pointer's
   move, a mouse's included.
5. Done 2026-11-25 (decision 172): the signed `view` is any name of one
   lowercase letter and up to 23 letters or hyphens; a follower shows the map
   for `"map"` and slides for any other, keeps following, and the follow bar
   shows a fixed note, wrapped on a phone, that a reload shows the newer
   view.
6. Later, after the new layout: moving frames by hand, as in Apple Freeform
   (decision 174, "later"). Positions are viewer state kept in the browser,
   never written to the Markdown (rule 1), with a control that resets the
   layout. Needs its own decision row first.
7. Optional simplifications: the camera's guards against NaN and enormous
   panes and their tests (about 50 and 285 lines); the diagram reload retry
   beyond row 146's visible note (needs a row, since 147 and 148 chose it).
   Done 2026-11-25: the helpers the map's browser tests shared moved into
   `src/map/testMap.ts` (152 lines fewer; each file's own mount harness stays,
   their props differ).
8. Done: the owner accepted rows 139 to 150 on 2026-11-16; 151 refines
   136, 142, 145, 149 and 150.

**Outside the map (lead).** Found by the security review, older than the map:
a follower's replay guard counts per sender id, and every presenter
connection gets a new one, so recorded presenter states from earlier
connections replayed once per follower, and with the map a replay could
switch a follower between the map and the slides. Fixed on `fix/replay-epoch`
(decision 170, 2026-11-16, merged in 5ac242c): the presenter's sender id starts with
the connection's epoch, which it signs, and followers, phones and agents drop
signed frames from an older epoch. The tab keeps the epoch rising across
reloads in `sessionStorage`, so a clock set back cannot freeze followers.
Six tests replay an earlier connection's frames (five in
`src/remote/remote.browser.test.ts`, one in `mcp/src/room.test.ts`). Gate:
`pnpm check` green (3674 tests, 36 Worker tests); the room specs (remote,
remote clock, mcp, follow frame, mirror, mirror focus, diagram tour mirror,
whiteboard, shapes, stylus) pass on Chromium (39), Firefox and WebKit (36
each, the 3 CDP pen tests skipped), and the map's follower tests on all
three (9). Still open, as 170 says: a follower that has just joined or
reloaded takes an earlier connection's frames until the presenter's first
frame reaches it.

### 2. A real-device UX pass, and what the review of PR #5 left

The code review is done (2026-11-11): three reviewers read the focus views
and tour, the whiteboard, stylus and saved marks, and the countdown and
comments. Decision 132 lists the thirteen defects fixed. Found and not fixed,
smallest first; each needs a failing test before code:

- Code colours on WebKit: fixed 2026-11-16 (decision 173). A page opened
  straight on its document coloured the first line of its first `ts` block as
  one token, because compiling the grammar outlasted Shiki's 500 ms per line.
  The worker now tokenizes a fixed warm-up text once per grammar as it loads,
  with no limit; document blocks keep the limit. `e2e/highlight.spec.ts`
  opens the document by link: red 3 of 3 on WebKit before, green 20 of 20
  after, on a machine loaded to 9-12 on 4 cores.
- Flaky, found 2026-11-17, not fixed: `e2e/comments.spec.ts`, the marker
  on a scaled slide (line 237). Pinned to two busy cores it failed 4 of 40 on
  `main` and 2 of 40 by link, always at the marker-position poll.
  `src/comments/slideMarkers.ts` rebuilds every marker button on each layout,
  so the poll can time out or read the box of a button already removed. Wait
  for a stable marker, or stop rebuilding unchanged ones. Also seen only in
  this container: Firefox's fraction check at `e2e/math.spec.ts:95` overlaps
  by 1.5 px against 1 allowed (5 of 5 on `main` here; CI passes it).
- Found while fixing it, not fixed: `src/remote/remote.browser.test.ts`, "a
  change goes out at once" (decision 112), failed once in the full `pnpm
  check` on a machine loaded to 14 on 4 cores, with one countdown message
  more than it counted (expected 2, got 3). It passed 5 of 5 alone under the
  same load, and CI passes it. The test counts messages after a fixed
  `settle()`; a second answer to the phone's hello may land after it.
  Reproduce under load (CONTRIBUTING point 5) and wait for the condition, not
  a fixed time.
- Comments: a reopened comment reads "edited" although its text never changed.
  A comment stores one time for any change, and a reopen must move it for
  merges to work, so the label needs a stored time of the last text change
  (an optional `edited` field in `DocComment`, set by `update` only). The
  owner chose that field on 2026-11-16 (decision 171): build it, test first. Drafts typed in the panel are
  lost when presenting starts, because the whole panel unmounts there.
- Eraser (drauu 1.0): a drag cut short by a slide change or the whiteboard
  toggle removes strokes from the screen and not from the saved record, so they
  return after a reload. This sits in drauu's eraser model and is left. (An
  eraser click that erased nothing no longer adds an undo step: `layer.ts`
  hands drauu none, 2026-11-14.)
- Fixed 2026-11-14 on `fix/next-up-2`: Start pressed twice with an invalid
  countdown target announces the message each time; an image-only line of a
  code view is named by its alt text (138); a blocked image in the table view
  is no button.
- Suspected, not shown from the code: a `#doc=…&c=…` link pasted into a tab
  that shows another document may merge its comments into the wrong one; two
  fast edits may detach a draft's comments; the glow on commented diagram nodes
  shows while presenting; a link or file can overwrite a local comment's text
  if it knows the id (row 65's "last edit wins"); a stage constructor that
  throws leaves the page inert under an empty focus overlay; saved marks are
  left out of an export when a slide's text changed after the last rebuild; the
  annotation layer is never built if IndexedDB never answers.

- Left by the fixes of 132: a comment stored before 132 under GitHub's old
  `-1` slug of a second heading with an empty slug, or on a diagram node under
  such a heading, now lists as orphaned, because anchors take the fallback id
  from `headingIds` (`src/comments/anchors.ts`); nothing is deleted. Marks
  saved before 132 on a slide that shows a failed diagram no longer show:
  their fingerprint held the diagnostic's text, which `src/annotate/markKeys.ts`
  now leaves out, and marking the slide again replaces them (a one-time loss,
  noted in row 132); Delete saved marks closes an open whiteboard; a held file or
  paste draft gets its alias when it opens, not at its first edit; on a layout
  that types `+` or `-` with AltGr the zoom keys do nothing in the view (the
  buttons work); when the old and the new key of a `?src=` document hold more
  than 500 comments together, the move of 120 fails at every open and the old
  key stays. Marks do the same past 105's caps (decision 137).

Still owed, by hand: the new features on a Mac trackpad, an iPhone and an
iPad (focus views and their pan and zoom, the tour, the whiteboard and stylus,
the countdown on a phone, saved marks, comments), with findings written here.

### 3. The next feature round

Every feature ranked in [`docs/feature-gaps.md`](./docs/feature-gaps.md)
for the last round is built. On 2026-11-16 the owner picked three for the next
round, from that file's candidates; none is urgent and none is started. Each
starts with a decision row (the lead's range, 170 onward), then failing tests,
then code.

1. **Overflow check from the command line and CI.** A command such as
   `docwalk check README.md` renders a document in a headless browser with
   docwalk's own pagination and reports every slide that carries an overflow
   note or a diagram error, with its section address, and exits non-zero when
   there are any. A team can run it on a pull request that changes a design
   doc. No tool in the survey does this; deckrun's lint is textual only.
   Measure in a real browser (rule 4), never by counting lines.
2. **Page numbers, a footer and bookmarks in the PDF export.** Slide numbers
   on each page, an optional footer with the document title, and PDF bookmarks
   from the section headings (Marp's `--pdf-outlines` is the model). The
   numbers follow sections chosen for the talk (decision 100).
3. **An agenda slide and section progress.** An optional agenda slide built
   from the headings, and a small "section 3 of 8" progress mark while
   presenting. Both come from the structure, with no new Markdown syntax
   (rule 1), and both can be switched off in the viewer.

After that round, re-check the survey as its "Re-check" section says.

## Later

- More locales after Turkish through Weblate; RTL with CSS logical
  properties.
