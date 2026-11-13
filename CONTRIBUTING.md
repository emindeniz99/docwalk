# Contributing to docwalk

Thanks for helping. Read [`docs/decisions.md`](./docs/decisions.md) before a
change of any size: it holds the settled design, and a change that goes
against a row starts by changing that row. [`CONTEXT.md`](./CONTEXT.md)
names things; use its words in code, docs and commit messages.

## Before you open a pull request

- Run `pnpm check`. It is the same gate CI runs: typecheck, lint, format,
  unit and real-browser tests, Worker tests and the static build. For UI
  changes, also run the end-to-end suite (`pnpm test:e2e`, or one engine
  with `--project chromium`).
- Write tests that say why the behaviour matters. Layout and pagination
  tests run in a real browser, never jsdom.
- Add a dependency only at a version published at least 7 days ago; pnpm
  refuses younger ones. Do not lower `minimumReleaseAge`.
- Keep personal data out of the project, fixtures and screenshots included.
- New UI strings go into `messages/en.json` and `messages/tr.json`. The
  Turkish glossary in `CONTEXT.md` lists the words to use.

## Picking up work

For maintainers and agents continuing the project:

1. Read [`AGENTS.md`](./AGENTS.md), then [`MEMORY.md`](./MEMORY.md) for
   the current state and local test setup.
2. Take work from [`ROADMAP.md`](./ROADMAP.md): "Next up" first, then
   "Follow-ups". Items under "Needs the owner" are the maintainer's.
3. A feature starts with a row in `docs/decisions.md`, then tests that
   fail, then code. Update ROADMAP and MEMORY in the same branch.
4. Before merging, run `pnpm check` and the end-to-end suite on the
   engines the change touches. The Pages site deploys by itself once
   "docwalk CI" passes on `main`; the deploy workflow can also be run by
   hand from the Actions tab.
5. A test that fails only sometimes is a race to find, not a retry to add.
   Reproduce it under load: keep two CPU cores busy with spin loops, pin
   the test run to them (`taskset`), repeat it 40 times or more, and
   record the failure count before and after the fix. Wait for the
   condition the next step needs, not for an earlier sign of readiness.
6. An agent session can hand pieces of work to the three agents in
   `.claude/agents/`: `scout` finds files, runs tests and reads logs and CI
   output, and edits nothing; `implementer` builds a well-scoped change from
   a spec, test first; `reviewer` takes review, hard debugging, design,
   refactors, migrations and performance work. Code edits and judgement
   calls on anything larger stay with the lead session or the reviewer.
   When a task falls short, first give it a way to check its own work (a
   test, a build, a script), then raise effort one level, then move it to
   the next agent up.

## Commit messages

docwalk uses [Conventional Commits](https://www.conventionalcommits.org)
with a scope on every commit:

```text
<type>(<scope>): <subject>

<body: why the change was needed>

<footers>
```

- **Type:** `feat`, `fix`, `docs`, `refactor`, `perf`, `test`, `chore`,
  `build`, `ci` or `revert`. Use `chore` when nothing else fits.
- **Scope (required):** the area the change touches, in kebab-case. Common
  scopes: `editor`, `deck`, `diagram`, `presenter`, `remote`, `export`,
  `canvas`, `comments`, `workspace`, `i18n`, `pwa`, `worker`, `mcp`, `design`,
  `ci`, `deps`, `docs`. A change that spans several areas takes the one it is
  mostly about, or splits into several commits.
- **Subject:** imperative mood ("add", not "added"), lowercase first letter,
  no trailing period, 72 characters or fewer for the whole first line.
- **Body:** explain why: the problem, the cause, and the trade-off when you
  chose a less obvious fix. Skip it for a trivial change. The diff already
  shows what changed.
- **One commit, one reason.** Split unrelated changes even when you made
  them together.
- **Breaking changes:** add `!` after the scope and a
  `BREAKING CHANGE: <what breaks and how to migrate>` footer.
- **AI attribution:** when a coding agent wrote a commit, or most of it, add
  a trailer that names the agent and model, for example
  `Co-Authored-By: <agent and model> <the vendor's attribution address>`.
  Use the vendor's own attribution address and the model's current name; a
  commit an agent wrote must not look human-only. If the environment can
  author commits as the agent's own service account, use that account as
  the author rather than the maintainer's name.
- **Signing:** sign commits when the environment provides a key, so GitHub
  shows them as Verified. An environment with no signing (some connectors)
  may commit unsigned; that never removes the attribution trailer.
- **Stage only this commit's files.** With other changes in the tree,
  commit by path (`git commit --only -m "…" -- path/a path/b`) or
  `git add` the paths and check `git diff --cached --name-only` first.
  Avoid `git add -A` unless every change shares the commit's reason.
- **Never** `--no-verify`, `--amend` on a pushed commit, or force-push
  `main`.

Examples:

```text
feat(deck): split an overflowing table at row boundaries
fix(worker): refuse a token request whose redirect_uri differs
docs(mcp): explain why the follow link cannot steer the deck
```

## Merging

The maintainer and agents working for them commit small, safe changes
(docs, test-only fixes, one-file bug fixes with a passing gate) straight to
`main`. Larger or independent work goes on a branch: a feature, a
dependency or toolchain change, anything touching security or the Worker.
That branch merges into `main` with a real merge commit, either through a
pull request or locally with `git merge --no-ff`, once the full gate
passes.

Pull requests merge with a real merge commit. Never squash or rebase-merge:
the per-commit history records how each part was built and why, and a
squash on `main` cannot be undone. Do not delete the branch as part of the
merge unless its author asks.

## GitHub Actions

Workflow changes follow these rules; the `zizmor` CI job enforces most of
them and must stay at zero findings.

- Trigger on `push` and plain `pull_request`, never `pull_request_target`.
  A `workflow_run` trigger needs a comment saying why it is safe.
- Declare `permissions:` with `contents: read` by default; only the job
  that needs more (a deploy, a release) gets it. Keep the repository's
  default token read-only.
- Pin every action to a full commit SHA with its tag in a comment.
- Pin only a release published at least 7 days ago, the same age rule as
  dependencies.
- Set `persist-credentials: false` on every checkout that does not push.
- Never put event fields an outsider controls (PR titles, branch names,
  comments) straight into a `run:` script; pass them through `env:`.
- No dependency cache in a workflow that publishes (the Pages deploy, a
  release): a poisoned cache would become the published artifact.
- Before the first npm publish of `docwalk-mcp`: `npm pack`, install the
  tarball in a clean project outside this repository, and run its `bin`.
  Node will not strip TypeScript types inside `node_modules`, so anything
  Node loads must be compiled. `npm publish` packs the working tree, so
  publish from a clean, pushed `main`.

## Reporting a vulnerability

See [`SECURITY.md`](./SECURITY.md). Please do not open a public issue for
one.
