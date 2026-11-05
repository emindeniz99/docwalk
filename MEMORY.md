# Memory — docwalk

What the next session needs to know. Read before working; update after
significant work; prune past ~100 lines.

## Now

Design settled, docs written, no code. Next: the week-1 spike in
`ROADMAP.md`, starting with the synthetic fixture and the AST sectioner.

## Decisions

- 2026-11-05: Full decision list lives in `docs/decisions.md` (45 rows) — keeps this file short.
- 2026-11-05: Option B (thin viewer on reveal.js, Mermaid, drauu, unified) over forking Slidekick, Marp Core or Slidev + WebContainer — Slidekick splits on H1 and silently shrinks, Marp Core v5 is an RC, WebContainer needs a paid licence for employee use.
- 2026-11-05: Vite SPA + Cloudflare Worker over Vinext — the UI runs entirely in the browser, and Vinext is pre-1.0.
- 2026-11-05: The owner chose full semantic pagination and OAuth in v1 against a reviewer's advice to stage them — accepted scope; slides are addressed by section id to keep links stable.

## Learnings

- 2026-11-05: reveal.js's Markdown plugin discards the separator match and is not fence-aware; split on the AST and hand reveal pre-built `<section>` HTML.
- 2026-11-05: GitHub's OAuth token exchange needs `client_secret` and has no CORS, PKCE included — browser-only OAuth is impossible, hence the Worker.
- 2026-11-05: A static `_headers` CSP cannot carry a per-visitor image setting, and a `<meta>` CSP cannot carry `frame-ancestors` — the sanitizer is the image gate.
- 2026-11-05: Mermaid and diagram hosts hide their own overflow; measure each host, not only the slide (deckrun `src/preview.ts`).

## Done

- 2026-11-05: Prior-art research, two independent reviews, project docs created.
