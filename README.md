# docwalk

Walk a team through a GitHub Markdown design doc. Paste or open an ordinary
`.md` file with Mermaid diagrams, and docwalk turns it into slides at its
headings, lets you zoom into any diagram, draw on it and point at it, and
tells you when content does not fit instead of clipping it. The file stays
plain GitHub Markdown.

Status: the first version is feature-complete and not yet released. The
CI workflows have not run on GitHub yet, and `docwalk-mcp` is not on npm.
[`ROADMAP.md`](./ROADMAP.md) lists what is open and
[`CHANGELOG.md`](./CHANGELOG.md) what the first release holds.

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
explains why none of them fits. [`docs/decisions.md`](./docs/decisions.md)
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
  mode. ⌘K or Ctrl+K opens a command palette; O opens a slide overview.
- Diagram focus: click a Mermaid diagram to fit, zoom, pan, draw on it with
  a pen or point with a laser.
- A presenter window with the current and next slide and a timer, synced
  over `BroadcastChannel` on the same machine.
- A phone remote and a follow-along link for other screens (full mode).
  The room key stays in the link's fragment, so the relay passes only
  ciphertext.
- Export to PDF through the print view, to one self-contained HTML file, or
  to a PNG per slide.
- GitHub alerts, footnotes on the slide that cites them, raw HTML filtered
  by GitHub's own sanitizer rules, and heading anchors that match GitHub's.

**Edit and keep**

- CodeMirror by default; Monaco as an optional editor on desktop (More
  actions › Editor).
- Canvas mode turns a Mermaid diagram into an Excalidraw sketch you can
  edit and export as `.excalidraw`, PNG or SVG. The Markdown stays as it
  was.
- Comments on a heading or a single diagram node. They travel in the share
  link and export to a `<name>.comments.json` sidecar.
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

## Quick start

You need Node 24.22.1 and pnpm 12.16.1 (with [mise](https://mise.jdx.dev),
`mise install` reads both from `package.json`).

```bash
pnpm install
pnpm dev
```

Open the address Vite prints. docwalk starts with a sample deck: paste your
own Markdown into the editor, drop a `.md` file on the page, or open
`/?src=<raw GitHub URL>`. Press **Present** to start, and use More actions
for the presenter window, export, the phone remote and the language.

## Self-hosting

`pnpm build` writes the app to `dist/`. One build serves both modes.

- **Static:** copy `dist/` to any static host (GitHub Pages, nginx, S3).
  Paste, drop, `?src=` links, share links, pasted GitHub tokens, the
  presenter window, export, the workspace and offline use all work. Sign-in,
  the phone remote, followers and agents need full mode, and the app hides
  them. The static build sets its content security policy with a `<meta>`
  tag, which cannot forbid framing; if your host can set headers, copy
  `public/_headers` into its configuration. `docwalk-deploy-pages.yml`
  publishes this mode to GitHub Pages under `/<repo>/`.
- **Full (Cloudflare):** `pnpm run deploy` builds the app and deploys it
  with a small Worker for GitHub App sign-in and the remote-control rooms.
  The Worker stores nothing and never sees a room's key.
  [`worker/README.md`](./worker/README.md) covers the GitHub App, the
  secrets, local runs and the variants without sign-in or without rooms.
  `docwalk-deploy-cloudflare.yml` runs the same deploy from GitHub; keep its
  Cloudflare token in the `docwalk-cloudflare` environment, limited to
  `main`.

## Privacy

- docwalk has no analytics, telemetry or hosted error reporting.
- Your document stays in your browser: in the editor, in the browser's
  storage, or in a local folder you opened. A share link carries it in the
  URL fragment, which browsers do not send to the server.
- Remote control encrypts every message end to end with a key that lives
  only in the link's fragment. The Worker relays ciphertext and keeps
  nothing.
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
pnpm dev              # local dev server
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
`--project chromium` runs one) and serves on port 4174 and 4175, or on
`DOCWALK_E2E_PORT` and the port after it. Lighthouse finds Chrome itself,
or uses `CHROME_PATH`.

If `pnpm install` reports a version "does not meet the minimumReleaseAge
constraint", the package is younger than 7 days. Wait, or pin the previous
release; do not lower the setting.

[`CONTRIBUTING.md`](./CONTRIBUTING.md) has the commit and merge rules;
[`SECURITY.md`](./SECURITY.md) says how to report a vulnerability.

## License

MIT. See [`LICENSE`](./LICENSE).
