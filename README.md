# docwalk

Walk a team through a GitHub Markdown design doc. Paste or open an ordinary
`.md` file with Mermaid diagrams, and docwalk turns it into slides at its
headings, lets you zoom into any diagram, draw on it and point at it, and
tells you when content does not fit instead of clipping it. The file stays
plain GitHub Markdown.

Status: design settled, no code yet. The spike plan is in
[`ROADMAP.md`](./ROADMAP.md).

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

Commands land with the first scaffold.

## License

MIT. See [`LICENSE`](./LICENSE).
