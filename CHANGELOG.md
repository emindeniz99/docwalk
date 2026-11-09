# Changelog

All notable changes to docwalk. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow
[Semantic Versioning](https://semver.org).

The first entry is the first public release. The commit history before it
records development: renames, internal refactors and reverted experiments.
None of it describes a change that a user of a release has to migrate from.

## [Unreleased]

The first release.

### Added

- Slides from an unmodified GitHub Markdown file: the slide level comes from
  Pandoc's rule or your choice, a lone H1 becomes the cover, and slides are
  addressed by section (`<section-id>/<n>`) so links survive edits.
- Semantic pagination: an overflowing slide splits at sub-headings, then at
  paragraphs, list items and table rows, with "· continued" titles and
  repeated table headers. Code blocks, diagrams and images stay whole, and
  one taller than a slide gets a visible note.
- Mermaid diagrams in strict mode, fitted from their viewBox, with diagram
  focus: zoom, pan, pen and laser.
- An editor view with live preview, outline, command palette and slide
  overview; a GitHub-style document view; presentation mode.
- A presenter window on the same machine; a phone remote and follow-along
  links through end-to-end encrypted rooms on the Cloudflare Worker. A
  follow screen fills the screen like the presenter's, with its status in a
  bar that hides when idle and stays while the connection is down.
- Export to PDF, a single self-contained HTML file and PNG images.
- Speaker notes: the HTML comments of a section show under the current
  slide in the presenter window, as plain text, on every page of the
  section. Comments that address a tool (`prettier-ignore`,
  `markdownlint-…`, `eslint-…`, `textlint-…`, `cspell:…`, `toc`) are
  skipped. GitHub hides comments, so the file reads the same there.
  Comments above the first heading open no slide; their notes go to the
  first one.
- Saved marks: pen and arrow marks stay in this browser per document and
  come back when you reopen it, on slides whose text has not changed. The
  PDF, HTML and PNG exports draw them unless you untick Export › Include
  marks; More actions › Delete saved marks removes them after a
  confirmation.
- Math and emoji shortcodes as GitHub renders them: `$…$`, ``$`…`$``,
  `$$…$$`, ` ```math ` fences and `:rocket:`. Formulas are drawn as MathML
  in a worker that stops after 500 ms, and a dollar amount such as
  `$5 and $10` stays text.
- A diagram tour: in a diagram's focus view, press T or Tour to step
  through a flowchart, class, state or ER diagram node by node along its
  edges. Nodes and edges off the path fade, and a status line names what the
  current node links to. Followers see the same path.
- A countdown in the presenter window: enter a target in minutes, pause and
  reset it, and read the time left, which goes below zero once you run over,
  with a label and an icon as well as colour. A pacing bar sets the share of
  time used against the share of slides done and says whether you are ahead,
  on pace or behind. The countdown survives a reload of the window.
- Search in the command palette reads slide text as well as titles. A word
  in a slide's body lists that slide under "In slide text" with a snippet and
  the match marked, and choosing it opens the page that holds the words.
  Code blocks are searched; diagrams and speaker notes are not.
- The screen stays awake while you present and while the presenter window is
  open, where the browser supports the Screen Wake Lock API.
- Inputs: paste, file drop, `?src=` links, `?repo=&path=` links, pasted
  fine-grained tokens and GitHub App sign-in.
- Share links with the document compressed into the URL fragment.
- GitHub alerts, footnotes, raw HTML under GitHub's sanitizer schema and
  GitHub-compatible heading anchors, including headings inside quotes,
  alerts and list items. A split slide shows each footnote on the page that
  cites it.
- A focus view for code blocks, tables and images, reusing the diagram's:
  a click or Enter opens it, Escape closes it, and focus returns to the
  block. Code and tables scroll and zoom their type, so a table wider than
  the slide can be read whole; in code you can click lines to mark them and
  clear the marks. Images open only once loaded, so the click-to-load gate
  for remote images is unchanged. While a view is open, O, the pen letters
  and the arrow keys do nothing outside it.
- Followers see what the presenter points at and draws: the laser (the
  presenter's own and a phone's), pen and arrow strokes with erase, undo,
  redo and clear, each slide's marks, and the diagram focus view with its
  zoom and pan, and the code, table and image focus views with their zoom,
  scroll and marked code lines. They travel in the room's encrypted messages, signed by the
  presenter, so another follower cannot put anything on your screen, and
  marks sit at the same place of the slide on any screen size. A follower
  who joins late or reconnects gets the slide's marks again. The presenter
  window shows the laser and marks over its current slide, with or without
  the Worker. A resync no longer
  clears a follower's marks first, a follower who joins during a stroke no
  longer cuts it, and resyncs slow down when they cost more, so a burst of
  followers cannot flood the presenter's connection.
- Task list items (`- [x]`, `- [ ]`) show their state as read-only boxes on
  slides, in document view, in the presenter's previews and in the HTML, PNG
  and print exports. A tick, not a colour, marks a done item, and a screen
  reader hears "Task done" or "Task not done". An `<input>` or `<form>` in
  the document is still removed.
- Choose which sections to present from the sidebar, the command palette
  or More actions. The link keeps the choice as `?sections=<id>,<id>`, and
  the deck, outline, palette, overview, presenter list and exports hold the
  chosen sections only; document mode and the editor keep the whole file.
- Code blocks coloured by language in 24 grammars, light and dark, loaded
  only for the languages a document uses. A grammar that loads late colours
  its blocks in place, and Markdown bold and italic in a code block take the
  function colour.
- Monaco as an optional desktop editor beside CodeMirror. A switch of
  editor keeps the cursor line, the command palette offers the other
  editor, a pick in one tab applies in the others, a list item's indented
  paragraphs are coloured as text, and Monaco's own panels are Turkish for
  Turkish viewers.
- Canvas mode: a Mermaid diagram as an editable Excalidraw sketch, kept in
  the browser and exported as `.excalidraw`, PNG or SVG. The sketch menu and
  zoom buttons have names, the Library no longer links to excalidraw.com, a
  Saved sketches panel deletes stored sketches, and full storage or a missing
  `crypto.subtle` is reported as such.
- Comments on headings and diagram nodes, carried in share links and
  exported as `<name>.comments.json` sidecars. Count markers sit beside
  commented headings on the slide itself; a deleted comment stays deleted
  when an older link, sidecar or tab is imported; node comments follow
  their diagram when diagrams are reordered; a new comment can carry a
  display name, kept in this browser.
- A browser workspace (files, folders, templates, zip import and export)
  and, in Chromium, local folders that reload on change and save on request.
  The workspace follows edits from another tab and asks before it writes over
  a file another tab changed or deleted. Save refuses to write over a local
  file it cannot read, and the zip export refuses to leave out files past the
  listing cap.
- `docwalk-mcp`, a local MCP server through which a coding agent reads the
  presenter's document, moves the deck and, when allowed, edits it.
- English and Turkish UI.
- An installable app that presents offline after one visit and asks before
  updating. Installed in Chromium on the desktop, it opens Markdown files
  from the file manager; it checks for a new version once an hour while open
  and visible, and F6 reaches the update prompt.
- Static self-hosting on any host, and full mode on Cloudflare with your
  own GitHub App.
