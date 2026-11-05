# docwalk

Walk a team through a GitHub Markdown design doc. Paste or open an ordinary
`.md` file with Mermaid diagrams, and docwalk turns it into slides at its
headings, lets you zoom into any diagram, draw on it and point at it, and
tells you when content does not fit instead of clipping it. The file stays
plain GitHub Markdown.

Status: early development. The splitter works; slide rendering, diagram
focus and overflow checks are in progress. See [`ROADMAP.md`](./ROADMAP.md).

## Why

- **Problem:** design docs live in GitHub Markdown and read well there, but
  a team discussing one has no good way to present it. Slide tools want
  their own syntax, shrink or clip what does not fit, and render large
  Mermaid diagrams too small to read.
- **Goal:** an unmodified GitHub doc in, an honest interactive review out.
  Slides come from the doc's own structure; diagrams can be explored;
  overflow is reported or paginated at semantic boundaries, never hidden.
- **Success:** a long, diagram-heavy design doc (`fixtures/`) presents well
  with zero edits, every overflow is either split at a safe boundary or
  flagged, and the app runs from a static host with no account.
- **Out of scope:** a new Markdown dialect, a collaborative whiteboard,
  storing documents on a server, rewriting the source to make it fit.

[`docs/prior-art.md`](./docs/prior-art.md) surveys the existing tools and
explains why none of them fits. [`docs/decisions.md`](./docs/decisions.md)
lists every settled design decision.

## How it will run

Two deployment modes, one build:

- **Static:** any static host (GitHub Pages, nginx, S3). Paste, drop,
  `?src=` links, share links and pasted GitHub tokens work.
- **Full:** Cloudflare, with a small Worker for GitHub App sign-in and, from
  v1.1, the remote-control relay. The app detects `/api` and enables those
  features.

In both modes the browser can install docwalk as an app, and after one
online visit it opens and presents offline. Mermaid loads code per diagram
type, and docwalk keeps only the types a deck has already shown, so a
diagram type you have never rendered needs a connection the first time.
When a new version is deployed, docwalk asks before reloading.

## Development

Requirements: Node 24.22.1 and pnpm 12.16.1. Both are pinned in
`package.json` (`devEngines`, `packageManager`); with
[mise](https://mise.jdx.dev), `mise install` picks them up.

```bash
pnpm install          # refuses packages published less than 7 days ago
pnpm dev              # local dev server
pnpm check            # the full gate: typecheck, lint, format, tests, build
pnpm test             # unit tests (Node)
pnpm test:browser     # layout tests in real Chromium
pnpm build            # static build in dist/, with sw.js and the manifest
pnpm icons            # redraw public/icons/ after a colour token changes
```

Browser tests need Chromium: `pnpm exec playwright install chromium`, or
point `DOCWALK_CHROMIUM_PATH` at an existing binary.

If `pnpm install` reports a version "does not meet the minimumReleaseAge
constraint", the package is younger than 7 days. Wait, or pin the previous
release; do not lower the setting.

## License

MIT. See [`LICENSE`](./LICENSE).
