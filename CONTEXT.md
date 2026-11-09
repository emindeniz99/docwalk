# CONTEXT.md: docwalk glossary

The words this project uses in code, docs, commits and the UI. One entry per
term, alphabetical. Numbers refer to rows in `docs/decisions.md`.

## Terms

**Agent**: a coding agent in a room through `docwalk-mcp`. It may read the
document and move the deck; it changes the document only while the
presenter has **agent edits** on (59, 67). Code: `RoomAgent`, `answerAgent`.

**Agent edits**: the "Allow agent edits" switch in the remote dialog. Off in
every new room and after a reload (67).

**Anchor**: what a comment points at: a heading's GitHub slug, or a Mermaid
node (nearest heading, diagram number under it, node id from the source).
Never a slide index or a character offset (55, 65). Code: `Anchor`.

**Atomic block**: a rendered block pagination never splits: a code block, a
Mermaid diagram, an image, a display equation. One taller than an empty
slide gets a **diagnostic** (19, 101).

**Base level**: the heading level that starts slides. `auto` picks it with
Pandoc's rule, skipping the **document title** (14); the user can override
it (20). Code: `SectionPlan.levels`.

**Document title**: the only H1, when it comes before every other heading.
It becomes the cover slide. Code: `findTitleHeading`.

**Breadcrumb**: the trail of parent headings shown on a slide, such as
`Failure handling › Retries` (15, 17).

**Continuation slide**: a slide pagination created from an overflowing
section. Its title carries "· continued"; a table on it repeats its header
(18).

**Countdown**: the presenter window's clock to a target time in whole
minutes. It pauses, resets, and goes below zero when the presenter runs
over. It is the window's own clock in `sessionStorage`, apart from the
Elapsed clock that reads the bridge's `startedAt` (80). Code: `Countdown`,
`src/presenter/pacing.ts`.

**Diagnostic**: a visible warning that content does not fit or cannot be
rendered. docwalk shows one instead of clipping or shrinking (19).

**Diagram focus**: the mode a click on a Mermaid diagram opens: fit, zoom,
pan, reset, fullscreen, pen and laser (3, 28, 29).

**Diagram tour**: stepping through a diagram's nodes in the diagram focus
view. The steps form a path, the last one current; it belongs to the open
view and is mirrored to followers as node numbers (109). Code:
`src/deck/diagramTour.ts`, `tourModel.ts`.

**Document mode**: the doc rendered as GitHub would show it, scrolling, no
slides (3, 10).

**Emoji shortcode**: `:name:` in text, shown as gemoji's character, as
GitHub does (`:rocket:` is 🚀). Only text nodes outside code, keys,
formulas and diagrams change; an unknown name stays as written, and titles,
breadcrumbs and the outline keep the shortcode (101). Code:
`src/render/emoji.ts`, `emojiMap.ts`.

**Focus view**: the full-window view that a click or Enter opens on a
diagram, a code block, a table or a loaded image. Diagrams and images zoom
and pan on a canvas; code and tables scroll and zoom by type size. One
dialog, toolbar, Tab trap and focus return serve all four (87). Code:
`src/deck/focus.ts`, `focusTargets.ts`.

**Full mode**: a deployment with the Worker, so `/api` exists: OAuth and
remote control (37, 38). Opposite: **static mode**.

**Line mark**: the fill and bar on a code line that the viewer clicked in a
code focus view. It belongs to the open view: it is never written to the
Markdown or the address, and it is gone when the view closes (87). The
presenter's line marks are mirrored to followers while the view is open
(106). Code: `aria-pressed` on `.docwalk-code-line`.

**Local folder**: a folder on disk the user opened through the File System
Access API. Its files are saved only on Save or Ctrl/Cmd+S, and reload when
they change on disk (58). Code: root `"folder"`.

**Math**: a formula in one of GitHub's four forms: inline `$…$` or
``$`…`$``, and the **display equation**, `$$…$$` on lines of their own or a
` ```math ` fence. docwalk draws it as MathML built from an allowlist after
both sanitizers; one it cannot draw keeps its TeX source. Temml runs in
the **math worker**, a dedicated Web Worker that gives each formula 500 ms.
A display equation is an **atomic block** that scrolls inside itself, and
one wider than the slide gets a **diagnostic** (101). Code:
`src/render/math.ts`, `mathRender.ts`, `math.worker.ts`, `mathTree.ts`,
`mathRebuild.ts`, `mathAllow.ts`.

**Mirror**: what the presenter shows others as it happens: the laser, pen,
arrow and shape marks, the whiteboard, and the focus view with its zoom, scroll and line marks.
Followers get it as signed `mirror` messages in slide units, and the
presenter window gets the laser and marks over the bridge. A focus view
names its block by kind and place on the slide (106). It goes outward only,
stays in memory and is never written to the Markdown (88). Code:
`src/annotate/mirrorFeed.ts`, `mirrorStore.ts`, `mirrorView.ts`,
`src/deck/focusMirror.ts`.

**Measurement pass**: the post-render check of a slide and each Mermaid host
for overflow, run in the order of decision 22.

**Orphaned comment**: a comment whose **anchor** is no longer in the
document. It stays listed apart until the user deletes it; it is never
dropped (55).

**Pacing bar**: two bars in the presenter window, the share of the target
used and the share of the slides done, with a verdict (ahead, on pace,
behind, over time). The slide on screen counts as half done, and the position
comes from the audience's address list (80). Code: `PacingBar`, `slideShare`.

**Part**: one encrypted piece of an agent message too large for a relay
frame, addressed to one participant (67). Code: `src/remote/parts.ts`.

**Present frame**: how the presented slide sits on the screen (77). **Fill**,
the default, gives it the whole screen up to its 16:9 fit and paints the
rest in the slide's colour; **card** is the white slide on the dark stage.
Code: `usePresentFrame`, `data-frame`.

**Presenting controls**: the bar above the slide while presenting (counter,
address, overview, Exit), the annotation tools and reveal.js's arrows. They
hide when nobody touches anything and the slide grows into their room (75).
Code: `usePresentChrome`, `data-chrome="hidden"`.

**Revision**: 16 bytes of the SHA-256 of the document text. An agent's write
that names an old revision is refused (67). Code: `revisionOf`.

**Saved marks**: the pen and arrow marks on a document's slides, kept in
this browser's IndexedDB under the document identity comments use and the
slide address. A slide shows them again only while its text is the text
they were drawn on. Exports draw them unless the Export menu's Include
marks is off; Delete saved marks, in More actions or the palette, removes
them. They never reach the Markdown (105). Code: `src/annotate/savedMarks.ts`,
`marksStore.ts`.

**Section**: the part of the AST between two slide starts at the base level.
One section yields one or more **slides**. Its id comes from the heading
slug and is stable across viewports (21); a heading with an empty slug
gets a **fallback address**, `heading-<hex code points>` (62). Code:
`headingIds`.

**Section selection**: the sections the viewer picks to present, kept in
the link as `?sections=<id>,<id>`. With none, or with every section
picked, the deck shows the whole document. The deck and what reads it
(outline, palette, overview, presenter list, exports) hold the picked
sections only; document mode and the editor keep the whole file (100).
Code: `applySelection`, `SectionPicker`.

**Sketch**: a Mermaid diagram converted into an editable Excalidraw drawing
(canvas mode), opened from the diagram focus view. It lives in the browser,
keyed by document and diagram source, and never changes the Markdown (54, 64).

**Sidecar**: `<name>.comments.json`, the file a document's comments export
to and import from (55). The share link carries the same JSON.

**Slide**: one screen in presentation mode, addressed as `<section-id>/<n>`
(21).

**Slide overview**: the grid of every slide's thumbnail, opened with O or
the grid button; Enter jumps to a slide. It replaces reveal.js's own
overview. Code: `SlideOverview`.

**Speaker note**: an HTML comment in a section, shown in the presenter
window under the current slide of that section. Tool directives such as
`prettier-ignore` are not notes. It is plain text, and it stays out of the
audience deck, document mode and exports (79). Code: `speakerNotes`.

**Static mode**: a deployment without the Worker. Everything except OAuth
and remote control works (37, 38).

**Task mark**: the empty, read-only box that stands where GitHub draws a
task item's checkbox. The state comes from the Markdown tree, the mark is
added after both sanitizers, and it is a drawing with a name, never a form
control (86). Code: `rehypeMarkTasks`, `rehypeDrawTasks`.

**Text hit**: a slide the command palette lists because its text holds the
query, not its title. It shows a snippet with the match marked and opens
the paginated page that holds the words. Diagrams and speaker notes are not
searched (81). Code: `SlideInfo.text`, `searchText`.

**Title slide**: a slide for a heading above the base level that has its own
content (15).

**Wake lock**: the browser's Screen Wake Lock, held while presenting and
while the presenter window is open, so the screen does not dim. It fails
without a message when the API is missing or refuses (80). Code:
`holdScreenAwake`, `useWakeLock`.

**Whiteboard**: a blank page over the slide box, one per section, addressed
`<section-id>/board`. It has its own marks, which are mirrored and saved
like a slide's, and a change of slide closes it (110). Code:
`src/annotate/board.ts`, `layer.setBoard`.

**Workspace**: the files and folders docwalk keeps for the user, either in
the browser's origin private file system (autosaved) or in a **local
folder**. The file panel above the outline shows it (57, 66). Several tabs
share the browser workspace through a `BroadcastChannel` and a Web Lock; an
edit one of them cannot write (the file is gone, or other text is on disk) is
**held back** until the user answers (90). The browser may clear it unless
**persistent** (91). Code: `src/workspace/`, document source
`{ kind: "workspace" }`.

## Turkish UI terms

The Turkish catalogue (`messages/tr.json`, decision 56) uses one word per
concept, and `src/i18n/glossary.test.ts` checks the rows a test can check.
Add a row here before introducing a new one.

| English                     | Turkish                     | Note                                       |
| --------------------------- | --------------------------- | ------------------------------------------ |
| slide                       | slayt                       | "slayt düzeyi" for the base level          |
| deck                        | slayt destesi               | screen-reader role only; elsewhere "sunum" |
| present (button)            | Sunum yap                   |                                            |
| presenter view              | sunucu görünümü             |                                            |
| presenting controls         | sunum düğmeleri             | not "kontrol", which also means check      |
| fill the screen, card       | ekranı doldur, kart         | the two present frames                     |
| presenter (the person)      | sunumu yapan kişi           | not "sunucu", which also means server      |
| speaker notes               | konuşmacı notları           | the comments panel in the presenter view   |
| target time, countdown      | hedef süre, geri sayım      | "kalan süre" for the time left             |
| pacing bar                  | tempo çubuğu                | the group's name in the UI is "Tempo"      |
| over time                   | süre aşıldı                 | also the verdict when the clock is past 0  |
| audience window             | ana sunum penceresi         | the presenter's own main tab               |
| follower, follow along      | izleyici, sunumu izle       | "izleyici" names people, never a window    |
| phone remote                | telefon kumandası           |                                            |
| remote control              | uzaktan kumanda             |                                            |
| outline                     | ana hat                     |                                            |
| section                     | bölüm                       |                                            |
| section selection           | bölüm seçimi                | "Bölümler: tümü" when there is none        |
| slide overview              | slaytlara genel bakış       |                                            |
| task mark                   | görev işareti               | named "tamamlandı", "tamamlanmadı"         |
| text hit                    | metin eşleşmesi             | the palette's "Slayt metninde" section     |
| diagram, node               | diyagram, düğüm             |                                            |
| math, formula, equation     | matematik, formül, denklem  | "denklem" in "N denklem fazla geniş"       |
| emoji shortcode             | emoji kısa kodu             | the `:name:` text, not the character       |
| diagram tour, step          | diyagram turu, adım         | "Tur" on the button                        |
| focus view                  | odak görünümü               | "tam ekran" in the dialog's names          |
| line mark                   | satır işareti               | the "Temizle" button removes them          |
| mark, saved marks           | işaret, kayıtlı işaretler   | pen and arrow marks; "Sil" deletes them    |
| mirror, mirrored            | yansıtma, yansıtılan        | the presenter's laser and marks on others  |
| sketch                      | çizim                       |                                            |
| whiteboard                  | beyaz tahta                 |                                            |
| rectangle, ellipse          | dikdörtgen, elips           | drawing tools                              |
| stylus                      | dokunmatik kalem            | the pen tool stays "Kalem"                 |
| comment, resolved, orphaned | yorum, çözüldü, sahipsiz    |                                            |
| workspace, local folder     | çalışma alanı, yerel klasör |                                            |
| draft                       | taslak                      |                                            |
| editor                      | düzenleyici                 | CodeMirror and Monaco keep their names     |
| token                       | erişim anahtarı             | "anahtar" once the context is clear        |
| agent, room                 | ajan, oda                   |                                            |
| export, import              | dışa aktar, içe aktar       |                                            |
| load                        | yükle                       |                                            |
| upload, nothing uploaded    | sunucuya gönder             | never "yükle", which means load            |

Style: address the reader as "siz" ("açın", "deneyin"). Never attach a
suffix to an interpolated value, because its vowel harmony is unknown:
put the value after a colon ("Kaydedilemedi: {path}") or before a word
that carries the suffix ("{path} klasörü", "{name} için"). Turkish nouns
stay singular after a number, so plurals need only an `other` branch.
