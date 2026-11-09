# docwalk

Walk a team through a GitHub Markdown design doc. Paste or open an ordinary
`.md` file with Mermaid diagrams, and docwalk turns it into slides at its
headings, lets you zoom into any diagram, draw on it and point at it, and
tells you when content does not fit instead of clipping it. The file stays
plain GitHub Markdown.

**Try it:** <https://emindeniz99.github.io/docwalk/>. It opens with a
sample design doc; paste your own Markdown or drop a `.md` file on the
page. Nothing is uploaded.

![The editor with its outline, the Markdown source and a live slide preview of a state diagram](docs/images/editor.png)

![Presentation mode: the slide on a dark stage with drawing tools](docs/images/present.png)

Status: beta. The first version is feature-complete and runs as a static
site on GitHub Pages; no version is tagged yet, and `docwalk-mcp` is not
on npm. Sign-in, the phone remote and agents need the Cloudflare Worker,
which the Pages site does not run. [`ROADMAP.md`](./ROADMAP.md) lists what
is open and [`CHANGELOG.md`](./CHANGELOG.md) what the first release holds.

## Why

- **Problem:** design docs live in GitHub Markdown and read well there, but
  a team discussing one has no good way to present it. Slide tools want
  their own syntax, shrink or clip what does not fit, and render large
  Mermaid diagrams too small to read.
- **Goal:** an unmodified GitHub doc in, an honest interactive review out.
  Slides come from the doc's own structure; you can explore the diagrams;
  docwalk reports overflow or paginates at a paragraph, list item or table
  row.
- **Success:** a long, diagram-heavy design doc (`fixtures/`) presents well
  with zero edits, docwalk splits or flags every overflow, and the app runs
  from a static host with no account.
- **Out of scope:** a new Markdown dialect, a collaborative whiteboard,
  storing documents on a server, rewriting the source to make it fit.

[`docs/prior-art.md`](./docs/prior-art.md) surveys the existing tools and
explains why none of them fits, and
[`docs/feature-gaps.md`](./docs/feature-gaps.md) lists what those tools offer
that docwalk does not yet. [`docs/decisions.md`](./docs/decisions.md)
lists every settled design decision.

## What it does

**Read and present**

- Slides start at the heading level Pandoc's rule picks (a lone H1 becomes
  the cover), or at the level you choose. A slide that overflows splits at
  its sub-headings, then at paragraphs, list items and table rows, with
  "· continued" titles and repeated table headers. A code block, diagram or
  image taller than a slide gets a visible note.
- Three views: an editor with a live slide preview and an outline, a
  document view that renders the file as GitHub would, and presentation
  mode. ⌘K or Ctrl+K opens a command palette that finds a slide by its title
  or by any words on it; O opens a slide overview.
- Presenting, the slide fills the screen edge to edge, and any room a
  screen that is not 16:9 leaves around it takes the slide's colour. More
  actions › Fill the screen when presenting switches back to a card on a
  dark stage.
- While you present, the slide counter, the drawing tools and the arrows
  fade out after three idle seconds; they lie over the slide, or, on the
  card, the slide grows into their room. Move the mouse, tap beside the
  slide or at the top of the screen, or press Tab to bring them back, or
  keep them with More actions › Always show presenting controls. Safari on
  iPhone cannot show a web page full screen: tap Share › Add to Home Screen
  and present from the home-screen icon for a full-screen deck.
- Drawing: a pen (P), an arrow (A), a rectangle (R), an ellipse (C), an
  eraser (E) and a laser (L). W opens a whiteboard, a blank page over the
  slide with marks of its own, one per section; changing slide closes it.
  Marks stay in this browser per document, and an export adds each
  whiteboard that has marks as a page after its section. With a stylus
  (Apple Pencil, Surface Pen, S Pen) the pen draws at once, and once it has
  touched the screen your fingers change slides instead of drawing. More
  actions › Stylus draws, fingers change slides turns that off.
- Diagram focus: click a Mermaid diagram to fit, zoom, pan, draw on it with
  a pen or point with a laser.
- Focus view for code blocks, tables and loaded images: click one, or focus
  it and press Enter, to see it full screen. Code and tables scroll and
  zoom their type; in code, click a line to mark it, as many as you like,
  and press Clear to remove them. Marks last until you close the view and
  never touch the Markdown. A remote image that is still waiting for you to
  load it does not open.
- A presenter window with the current and next slide and a timer, synced
  over `BroadcastChannel` on the same machine. Enter a target time in
  minutes for a countdown with pause and reset, and a pacing bar that shows
  whether the slides keep up with the clock. The screen stays on while you
  present.
- Speaker notes: write an HTML comment (`<!-- … -->`) under a heading and
  the presenter window shows it under that slide. GitHub hides comments, so
  the document reads the same there. The notes are plain text; tool
  comments such as `<!-- prettier-ignore -->` or `<!-- markdownlint-disable -->`
  are skipped. They sit in the document text, so a share link or a remote
  room carries them too.
- A phone remote and a follow-along link for other screens (full mode).
  The room key stays in the link's fragment, so the relay passes only
  ciphertext. A follower sees your laser, your pen marks and the diagram
  you open in focus, in the same place on its own screen size; the
  presenter window shows the laser and marks too. Nothing a follower does
  reaches you or other followers.
- Export to PDF through the print view, to one self-contained HTML file, or
  to a PNG per slide.
- GitHub alerts, footnotes on the slide that cites them, raw HTML filtered
  by GitHub's own sanitizer rules, and heading anchors that match GitHub's.
- Code blocks coloured by language with GitHub's colours, on slides, in
  document mode and in exports: TypeScript, JavaScript, JSON, shell,
  Python, Go, Rust, Java, Kotlin, Swift, C, C++, C#, SQL, YAML, TOML, HTML,
  CSS, diff, Markdown, Dockerfile and GraphQL. Other languages stay plain.

**Edit and keep**

- CodeMirror by default; Monaco as an optional editor on desktop (More
  actions › Editor).
- Canvas mode turns a Mermaid diagram into an Excalidraw sketch you can
  edit and export as `.excalidraw`, PNG or SVG. The Markdown stays as it
  was.
- Comments on a heading or a single diagram node. They travel in the share
  link and export to a `<name>.comments.json` sidecar.
- Pen and arrow marks stay with the document in your browser. Reopen it and
  each slide shows its marks again, as long as its text has not changed.
  The PDF, HTML and PNG exports draw them over the slides; untick Export ›
  Include marks for clean slides, or remove them with More actions › Delete
  saved marks.
- A workspace of files and folders in the browser's private file system,
  with templates and zip import and export. In Chromium you can open a local
  folder instead: docwalk reloads files that change on disk and writes only
  when you save.
- Share links: `?src=` and `?repo=` links for files on GitHub, or the whole
  document compressed into the link's fragment.
- English and Turkish UI, switched in More actions › Language.
- Installable as an app. After one online visit it opens and presents
  offline, and it asks before reloading into a new version.

**Agents**

In full mode, a coding agent can read the presenter's document, move the
deck and, once the presenter allows it, edit the document through
[`docwalk-mcp`](./mcp/README.md), a local MCP server that joins the room with
its encrypted link.

## Use it

Open <https://emindeniz99.github.io/docwalk/> in a current browser. Paste
Markdown into the editor, drop a `.md` file on the page, or open
`https://emindeniz99.github.io/docwalk/?src=<raw GitHub URL>`. Press
**Present** to start. Install it from the browser's menu to use it offline;
on an iPhone, Safari's **Share › Add to Home Screen** also gives a deck
without the browser bars, since iPhone Safari has no full-screen mode for
pages.

## Develop

You need Node 24.22.2 and pnpm 12.16.1 (with [mise](https://mise.jdx.dev),
`mise install` reads both from `package.json`).

```bash
pnpm install
pnpm dev
```

Open the address Vite prints. docwalk starts with a sample deck: paste your
own Markdown into the editor, drop a `.md` file on the page, or open
`/?src=<raw GitHub URL>`. Press **Present** to start. **Export** next to
**Share** saves PDF, HTML or PNG; More actions opens the presenter window,
the phone remote, the editor choice and the language.

## Self-hosting

`pnpm build` writes the app to `dist/`. One build serves both modes.

- **Static:** copy `dist/` to the root of any static host (nginx, S3, a
  GitHub Pages user site). The default build links its scripts, manifest and
  service worker from `/`, so at a sub-path the page loads blank. To serve
  it under a path, such as a GitHub Pages project site at
  `https://<user>.github.io/<repo>/`, build with that path and copy the new
  `dist/`: `pnpm exec vite build --base /<repo>/`.
  Paste, drop, `?src=` links, share links, pasted GitHub tokens, the
  presenter window, export, the workspace and offline use all work. Sign-in,
  the phone remote, followers and agents need full mode, and the app hides
  them. The static build sets its content security policy with a `<meta>`
  tag, which cannot forbid framing; if your host can set headers, copy
  `public/_headers` into its configuration.
  [`deploy-pages.yml`](./.github/workflows/deploy-pages.yml) publishes this
  mode to GitHub Pages under `/<repo>/`.
- **Full (Cloudflare):** `pnpm run deploy` builds the app and deploys it
  with a small Worker for GitHub App sign-in and the remote-control rooms.
  The Worker stores no documents, messages or tokens and never sees a
  room's key.
  [`worker/README.md`](./worker/README.md) covers the GitHub App, the
  secrets, local runs and the variants without sign-in or without rooms.
  [`deploy-cloudflare.yml`](./.github/workflows/deploy-cloudflare.yml) runs
  the same deploy from GitHub; keep its
  Cloudflare token in the `docwalk-cloudflare` environment, limited to
  `main`.

## Privacy

- docwalk has no analytics, telemetry or hosted error reporting.
- Your document stays in your browser: in the editor, in the browser's
  storage, or in a local folder you opened. A share link carries it in the
  URL fragment, which browsers do not send to the server.
- Remote control encrypts every message end to end with a key that lives
  only in the link's fragment. The Worker relays ciphertext. Each room
  stores only a hash of its control seat token, deleted at most a week
  after the room empties.
- docwalk fetches a `?src=` URL from GitHub's raw and gist hosts at once,
  and asks you first for any other host. Remote images in a document load
  only when you click them or switch on "Always load remote images".
- A pasted GitHub token stays in `sessionStorage` for that tab. Sign-in
  through the GitHub App asks for read access to the repositories you pick.
- Fonts come from the build, not a font CDN.

## Browser support

docwalk targets Baseline widely available features, with Safari 17.4 as the
floor. CI runs the end-to-end suite on Chromium, Firefox and WebKit.

- Local folders need the File System Access API, so only Chromium-based
  browsers offer them.
- The browser workspace needs writable OPFS files: Safari 26 or later, and
  not in private windows.
- Monaco is offered on desktop only; touch devices keep CodeMirror.

## Development

```bash
pnpm install          # refuses packages published less than 7 days ago
pnpm dev              # local dev server, static mode (no /api)
pnpm dev:worker       # build, then the app and the Worker on one origin (full mode)
pnpm check            # the full gate: typecheck, lint, format, tests, build
pnpm test             # unit tests (Node)
pnpm test:browser     # layout tests in real Chromium
pnpm build            # static build in dist/ (with sw.js and the manifest), docwalk-mcp in mcp/dist/
pnpm size             # app shell size from dist/ (run pnpm build first)
pnpm test:e2e         # Playwright on Chromium, Firefox, WebKit, plus a /docwalk/ sub-path build
pnpm lighthouse       # Lighthouse CI budgets on dist/ (run pnpm build first)
pnpm mutation         # StrykerJS on the unit tests; report in reports/mutation/
pnpm icons            # redraw public/icons/ after a colour token changes
```

Browser tests need Chromium: `pnpm exec playwright install chromium`, or
point `DOCWALK_CHROMIUM_PATH` at an existing binary. The end-to-end suite
needs all three engines (`pnpm exec playwright install firefox webkit`;
`--project chromium` runs one) and serves on port 4174, or on
`DOCWALK_E2E_PORT`. A run that includes the `static-subpath` project, as a
run with no `--project` does, also builds the sub-path app and serves it on
the next port. Lighthouse finds Chrome itself,
or uses `CHROME_PATH`.

If `pnpm install` reports a version "does not meet the minimumReleaseAge
constraint", the package is younger than 7 days. Wait, or pin the previous
release; do not lower the setting.

[`CONTRIBUTING.md`](./CONTRIBUTING.md) has the commit and merge rules;
[`SECURITY.md`](./SECURITY.md) says how to report a vulnerability.

## License

MIT. See [`LICENSE`](./LICENSE).
