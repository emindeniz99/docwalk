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
Mermaid diagram, an image. One taller than an empty slide gets a
**diagnostic** (19).

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

**Diagnostic**: a visible warning that content does not fit or cannot be
rendered. docwalk shows one instead of clipping or shrinking (19).

**Diagram focus**: the mode a click on a Mermaid diagram opens: fit, zoom,
pan, reset, fullscreen, pen and laser (3, 28, 29).

**Document mode**: the doc rendered as GitHub would show it, scrolling, no
slides (3, 10).

**Full mode**: a deployment with the Worker, so `/api` exists: OAuth and
remote control (37, 38). Opposite: **static mode**.

**Local folder**: a folder on disk the user opened through the File System
Access API. Its files are saved only on Save or Ctrl/Cmd+S, and reload when
they change on disk (58). Code: root `"folder"`.

**Measurement pass**: the post-render check of a slide and each Mermaid host
for overflow, run in the order of decision 22.

**Orphaned comment**: a comment whose **anchor** is no longer in the
document. It stays listed apart until the user deletes it; it is never
dropped (55).

**Part**: one encrypted piece of an agent message too large for a relay
frame, addressed to one participant (67). Code: `src/remote/parts.ts`.

**Revision**: 16 bytes of the SHA-256 of the document text. An agent's write
that names an old revision is refused (67). Code: `revisionOf`.

**Section**: the part of the AST between two slide starts at the base level.
One section yields one or more **slides**. Its id comes from the heading
slug and is stable across viewports (21); a heading with an empty slug
gets a **fallback address**, `heading-<hex code points>` (62). Code:
`headingIds`.

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

**Static mode**: a deployment without the Worker. Everything except OAuth
and remote control works (37, 38).

**Title slide**: a slide for a heading above the base level that has its own
content (15).

**Workspace**: the files and folders docwalk keeps for the user, either in
the browser's origin private file system (autosaved) or in a **local
folder**. The file panel above the outline shows it (57, 66). Code:
`src/workspace/`, document source `{ kind: "workspace" }`.

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
| presenter (the person)      | sunumu yapan kişi           | not "sunucu", which also means server      |
| audience window             | ana sunum penceresi         | the presenter's own main tab               |
| follower, follow along      | izleyici, sunumu izle       | "izleyici" names people, never a window    |
| phone remote                | telefon kumandası           |                                            |
| remote control              | uzaktan kumanda             |                                            |
| outline                     | ana hat                     |                                            |
| section                     | bölüm                       |                                            |
| slide overview              | slaytlara genel bakış       |                                            |
| diagram, node               | diyagram, düğüm             |                                            |
| sketch                      | çizim                       |                                            |
| comment, resolved, orphaned | yorum, çözüldü, sahipsiz    |                                            |
| workspace, local folder     | çalışma alanı, yerel klasör |                                            |
| draft                       | taslak                      |                                            |
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
