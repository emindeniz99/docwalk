# Agent instructions: docwalk

Read these in order before any non-trivial work:

1. [`MEMORY.md`](./MEMORY.md): current state and what the last session
   learned.
2. [`docs/decisions.md`](./docs/decisions.md): the settled decisions. Change
   the decision before changing the code it describes: a later row that
   names the row it refines or supersedes, or an ADR under `docs/adr/` when
   the reasons need more than a row.
3. This file: the project rules.

Naming goes through [`CONTEXT.md`](./CONTEXT.md). The roadmap is in
[`ROADMAP.md`](./ROADMAP.md).

## Project rules

1. **The Markdown file is the API.** docwalk never requires syntax GitHub
   would not render, and never writes to the source to make it fit.
   Viewer state (level override, theme, annotations) lives in the URL or
   the browser, never in the document.
2. **Split on the AST, never with a regex.** A `---` under a paragraph is a
   setext heading; a `---` inside a fence is text. Every sectioning and
   pagination step works on the parsed tree or on the rendered DOM.
3. **Overflow is reported or split, never hidden.** No global shrink, no
   silent clipping. Code blocks, diagrams and images stay whole; one taller
   than an empty slide gets a visible diagnostic.
4. **Measure only after everything has rendered:** `document.fonts.ready`,
   then code highlighting and `mermaid.run()`, then image decode, then one
   animation frame.
   Measure each Mermaid host on its own as well as the slide, because
   diagram hosts hide their own overflow.
5. **Every input is hostile.** Markdown goes through rehype-sanitize with
   the GitHub schema and then DOMPurify. Mermaid runs in `strict` mode after
   a pre-pass that strips `%%{init}%%` overrides and CSS `url()`; a diagram
   whose parse names a remote image is refused; `bindFunctions` is never
   called and its SVG goes through DOMPurify. Remote images load only through the sanitizer's
   click-to-load rewrite or the "always load" setting. Tokens live in
   `sessionStorage`, never `localStorage`, never in logs.
6. **The static build must work on its own.** Anything that needs `/api`
   (OAuth, remote control) is feature-detected and hidden when the Worker is
   absent. CI builds and tests the static output.
7. **Slides are addressed by section, not by index.** Measured pagination
   depends on viewport and fonts, so links use `<section-id>/<n>`.
8. **No analytics, no telemetry, no outbound calls the user did not ask
   for.** A change that adds one needs a decision first.
9. **Tests state why.** Layout and pagination tests run in a real browser
   (Vitest Browser Mode or Playwright), never jsdom. Property tests guard
   the pagination invariants: no content lost, none duplicated, every slide
   fits or carries a diagnostic.
10. **Dependencies:** newest versions at least 7 days old (pnpm
    `minimumReleaseAge: 10080`), as a guard against freshly published
    malicious releases. No personal data anywhere in the project, fixtures
    included.
11. **Commits and merges follow [`CONTRIBUTING.md`](./CONTRIBUTING.md)**,
    in English:
    - Conventional Commits with a required area scope: `feat(deck): …`,
      `fix(worker): …`, `docs(mcp): …` (scopes such as `editor`, `deck`,
      `worker`, `mcp`, `i18n`; kebab-case for more than one word).
      Imperative, lowercase subject, no trailing period, 72 characters or
      fewer for the whole first line.
    - The body explains why; one commit carries one reason.
    - A commit you wrote ends with a `Co-Authored-By:` trailer naming your
      agent and current model with the vendor's attribution address. Never
      leave an agent-written commit looking human-only.
    - Small, safe changes (docs, test-only fixes, one-file bug fixes with
      a passing gate) go straight to `main`. Features and risky changes
      use a branch.
    - Branches merge with a real merge commit, by pull request or
      `git merge --no-ff`. Never squash or rebase-merge, and do not delete
      the branch unless asked.

## How to work

These hold for every task, for people and agents alike.

1. **Think before coding.** State your assumptions. When a request has
   more than one reading, or a simpler route exists, say so and ask
   instead of picking silently.
2. **Simplest change that works.** No features, options or abstractions
   nobody asked for. If 200 lines could be 50, rewrite it.
3. **Surgical edits.** Touch only what the task needs and match the
   surrounding style. Mention unrelated dead code instead of deleting it;
   remove only what your own change made unused.
4. **Define done, then verify it.** Turn the task into a check (a failing
   test, a measurement) and loop until it passes. Read the code you change
   and its callers before writing.
5. **Surface conflicts.** When two patterns or decisions disagree, pick
   one, say why, and flag the other; never blend them.
6. **Checkpoint and fail loud.** After each significant step, say what is
   done, what is verified and what is left. "Done" is wrong if a step was
   skipped; "tests pass" is wrong if any were skipped. Never skip, weaken or
   retry a test to get green.
7. **A timed-out or hung test run is a finding.** Stop and report the test
   that hung; do not rerun it in a loop. Check for leftover browser or
   test-server processes before the next run.
8. **English everywhere in the repo:** code, comments, docs, commit
   messages, pull requests. Prose that outlives a conversation (README,
   docs, commit and PR bodies) goes through the
   [`stop-slop`](./.claude/skills/stop-slop/SKILL.md) skill.
9. **Agents in a shell:** absolute paths, and a tool's own directory flag
   (`pnpm --dir`, `git -C`) instead of `cd dir && …`, so permission checks
   can resolve every path. Read and search with the editor's file tools, not
   `cat` or `grep`.
