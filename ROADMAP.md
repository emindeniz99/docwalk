# Roadmap: docwalk

Dated 2026-11-05. Update this file when an item ships or a deferred item's
trigger fires, and delete the entry in the same commit.

## v1

### Week 1: spike (decides rows 27 and 28)

Done on 2026-11-05: steps 1 to 6, except the presenter window. reveal.js's
notes plugin was tried and dropped: its preview frames reload the page URL,
so they show the app shell and the default document instead of the deck
(decision 8 already calls for a BroadcastChannel presenter window). Other
limits still open: footnotes
render only in the section that holds their definition; raw HTML is dropped
until rehype-raw is added behind the sanitizer; overflowing slides scroll
inside the slide with a diagnostic when even an atomic block does not fit.

1. Write the acceptance fixture in `fixtures/`: a long synthetic design doc
   with many `##` and `###` sections, flowcharts, sequence and state
   diagrams, long lists, an oversized table, code and links. No personal
   content.
2. Scaffold: pnpm, Vite 8, React 19, TypeScript, Vitest 5, mise pins.
3. AST sectioning with the auto base level, title slides, breadcrumbs and
   thematic breaks, with unit and property tests.
4. reveal.js 6 embedded in a container React does not reconcile; slides
   rendered from the sections; presenter window.
5. Mermaid 12 in `strict` behind the pre-pass; diagram focus with d3-zoom and
   with `@panzoom/panzoom`, then pick one.
6. Measurement pass and diagnostics, run in Vitest Browser Mode against the
   fixture.

Exit rule: if reveal.js still needs patches at the end of week 2, replace it
with a custom shell (overview grid, keyboard, fullscreen).

### After the spike

- Done 2026-11-05: presenter window over `BroadcastChannel` (current and
  next slide, timer, slide list, prev/next driving the audience deck);
  slide addresses in the URL; CodeMirror 6 editor (gutter notes, reveal,
  cursor sync); pen, arrow, eraser and laser with per-slide marks;
  Playwright end-to-end suite in CI.
- Follow-ups from the module reviews: GitHub alerts (`> [!NOTE]`) need
  rehype-github-alert behind the sanitizer (decision 25); undo history does
  not survive a slide switch (one drauu instance per slide would fix it);
  presenter previews do not show overflow notes; a sub-heading anchor that
  is not a slide falls back to the first slide; empty-slug headings get no
  linkable address.
- Bundle: first load is 295 KB gzip (JS+CSS), checked by size-limit in
  CI (fails above 1 MB, warns above 500 KB). Optional cut: stop the presenter window importing
  reveal.js through `deck/Deck.tsx`, then defer the React Aria menu pieces.
- Done 2026-11-05: H3 fallback and semantic pagination (paragraphs, list
  items with `<ol start>`, table rows with repeated headers, "· continued"
  titles, `<section-id>/<page>` addresses). The fixture goes from 23 slides
  with 10 overflowing to 47 slides with 1 (an atomic block).
- Pagination refinement: merge adjacent sub-heading groups that fit on one
  slide together (today every H3 group gets its own slide once a section
  splits).
- Done 2026-11-05: inputs (drop, file open, `?src=` with a confirmation for
  hosts outside the allowlist, `?repo=`, pasted token); Worker with GitHub
  App OAuth (PKCE, `state`, fixed `redirect_uri`, origin-bound CORS) and
  `@cloudflare/vitest-plugin` tests; sharing (fragment codec, autosave
  drafts); exports (PDF, single-file HTML, PNG); remote control (moved up
  from v1.1, see decision 8); Playwright suite with axe on nine surfaces.
- Pen and laser; overview; themes; light/dark.
- PWA; Paraglide i18n scaffolding; accessibility pass to WCAG 2.2 AA.
- CI: static build, Playwright on three engines, axe, size-limit, Lighthouse
  CI, sanitizer corpus, nightly Stryker.
- Cloudflare deploy with the `_headers` CSP; static build with the meta CSP.
- Done 2026-11-05: `DESIGN.md`, token module, parity test, self-hosted fonts, Stage look on the deck.
- Done 2026-11-05: app shell on React Aria (outline with page counts and note dots, ⌘K palette, edit/document switch, present in fullscreen, light/dark/system theme), deck controller API, contracts for editor, annotation, presenter and URL modules.

## v2: workspace and agents

After v1 ships. Each item needs a decision row before code.

1. **Workspace in the browser.** Folders and files kept in the origin
   private file system (OPFS), so nothing leaves the device: a file tree
   beside the outline, New file, New folder, rename, delete, and "New
   project" from a template. Import and export a project as a zip.
2. **Open a local folder.** The File System Access API
   (`showDirectoryPicker`, Chromium only; other browsers keep the OPFS
   workspace). Reload a file when it changes on disk (`FileSystemObserver`
   where available, polling otherwise). This is the agent path for local
   agents: an agent edits the `.md` file and the open deck updates, with no
   protocol of our own.
3. **MCP server for agents that cannot reach the disk** (cloud agents,
   chat apps). A remote MCP endpoint on the Worker with tools such as
   `get_document`, `write_document`, `list_slides` and `goto_slide`, pushing
   into a room the viewer has joined. Open questions: rooms are end-to-end
   encrypted, so the agent needs the room key (the join link) or the room
   runs unencrypted with the viewer's consent; authentication through the
   GitHub App.

## Later

- Monaco as an optional editor behind the editor interface.
- Turkish UI, then more locales through Weblate; RTL with CSS logical
  properties.
- GitHub Pages static deploy, once the repository is public.
- Canvas mode with Excalidraw and `@excalidraw/mermaid-to-excalidraw`.
- Comments anchored to headings or Mermaid node ids (`data-id`).
