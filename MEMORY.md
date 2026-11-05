# Memory — docwalk

What the next session needs to know. Read before working; update after
significant work; prune past ~100 lines. One dated line per entry; rewrite
**Now** in place, append to the other sections.

## Now

Design settled, docs and the acceptance fixture written, no code. Next: the
scaffold and the AST sectioner from the week-1 spike in `ROADMAP.md`.

## Decisions

- 2026-11-05: The full decision list lives in `docs/decisions.md` (45 rows); the evidence is in `docs/prior-art.md`. This file stays short.
- 2026-11-05: Thin viewer on reveal.js, Mermaid, drauu and unified, over forking Slidekick, Marp Core or Slidev + WebContainer: Slidekick splits on H1 and silently shrinks, Marp Core v5 is a release candidate, WebContainer needs a paid licence for employee use.
- 2026-11-05: Vite SPA + Cloudflare Worker over Vinext: the UI runs entirely in the browser, and Vinext is pre-1.0.
- 2026-11-05: Full semantic pagination and OAuth ship in v1, against a reviewer's advice to stage them. Slides are addressed by section id to keep links stable.

## Learnings

- 2026-11-05: reveal.js's Markdown plugin discards the separator match and is not fence-aware; split on the AST and hand reveal pre-built `<section>` HTML.
- 2026-11-05: GitHub's OAuth token exchange needs `client_secret` and has no CORS, PKCE included: browser-only OAuth is impossible, hence the Worker.
- 2026-11-05: A static `_headers` CSP cannot carry a per-visitor image setting, and a `<meta>` CSP cannot carry `frame-ancestors`: the sanitizer is the image gate.
- 2026-11-05: Mermaid and other diagram hosts hide their own overflow; measure each host, not only the slide (deckrun `src/preview.ts`).

## Done

- 2026-11-05: Acceptance fixture `fixtures/ledger-redesign.md` (809 lines, 7 Mermaid diagrams, all parse with Mermaid 11.12).
- 2026-11-05: Prior-art research, design review, decision list and project docs.
