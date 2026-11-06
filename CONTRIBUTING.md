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
  commit an agent wrote must not look human-only.

Examples:

```text
feat(deck): split an overflowing table at row boundaries
fix(worker): refuse a token request whose redirect_uri differs
docs(mcp): explain why the follow link cannot steer the deck
```

## Merging

Pull requests merge with a real merge commit. Never squash or rebase-merge:
the per-commit history records how each part was built and why, and a
squash on `main` cannot be undone. Do not delete the branch as part of the
merge unless its author asks.

## Reporting a vulnerability

See [`SECURITY.md`](./SECURITY.md). Please do not open a public issue for
one.
