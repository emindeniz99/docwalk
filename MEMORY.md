# Memory — docwalk

What the next session needs to know. Read before working; update after
significant work; prune past ~100 lines. One dated line per entry; rewrite
**Now** in place, append to the other sections.

## Now

Scaffold (Vite 8, React 19, TS 7, Vitest 5, pnpm 12) and the AST sectioner
(`src/sectioning/sectionize.ts`, 23 unit + property tests) are done. Next:
reveal.js embedded rendering of the sections, then Mermaid focus and the
measurement pass (`ROADMAP.md` week 1, steps 4–6).

Local run in the cloud container: `PATH=/opt/node24/bin:$PATH npx -y
pnpm@12.16.1 --dir <project> <script>` (no mise there).

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
- 2026-11-05: Pandoc's rule alone gives H1 slides for a README (`# Name` + intro). The lone-H1 title rule fixes that; restricting it to H1 keeps a single `##` with `###` children from being mistaken for a title.
- 2026-11-05: Property tests must reuse one parsed tree; re-parsing makes new node objects and identity checks fail for no real reason.

## Done

- 2026-11-05: Acceptance fixture `fixtures/ledger-redesign.md` (809 lines, 7 Mermaid diagrams, all parse with Mermaid 11.12).
- 2026-11-05: Prior-art research, design review, decision list and project docs.
