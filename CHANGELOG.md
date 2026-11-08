# Changelog

All notable changes to docwalk. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow
[Semantic Versioning](https://semver.org).

The first entry is the first public release. The commit history before it
records development: renames, internal refactors and reverted experiments.
None of it describes a change that a user of a release has to migrate from.

## [Unreleased]

The first release.

### Added

- Slides from an unmodified GitHub Markdown file: the slide level comes from
  Pandoc's rule or your choice, a lone H1 becomes the cover, and slides are
  addressed by section (`<section-id>/<n>`) so links survive edits.
- Semantic pagination: an overflowing slide splits at sub-headings, then at
  paragraphs, list items and table rows, with "· continued" titles and
  repeated table headers. Code blocks, diagrams and images stay whole, and
  one taller than a slide gets a visible note.
- Mermaid diagrams in strict mode, fitted from their viewBox, with diagram
  focus: zoom, pan, pen and laser.
- An editor view with live preview, outline, command palette and slide
  overview; a GitHub-style document view; presentation mode.
- A presenter window on the same machine; a phone remote and follow-along
  links through end-to-end encrypted rooms on the Cloudflare Worker.
- Export to PDF, a single self-contained HTML file and PNG images.
- Speaker notes: the HTML comments of a section show under the current
  slide in the presenter window, as plain text, on every page of the
  section. Comments that address a tool (`prettier-ignore`,
  `markdownlint-…`, `eslint-…`, `textlint-…`, `cspell:…`, `toc`) are
  skipped. GitHub hides comments, so the file reads the same there.
- Inputs: paste, file drop, `?src=` links, `?repo=&path=` links, pasted
  fine-grained tokens and GitHub App sign-in.
- Share links with the document compressed into the URL fragment.
- GitHub alerts, footnotes, raw HTML under GitHub's sanitizer schema and
  GitHub-compatible heading anchors.
- Code blocks coloured by language in 24 grammars, light and dark, loaded
  only for the languages a document uses.
- Monaco as an optional desktop editor beside CodeMirror.
- Canvas mode: a Mermaid diagram as an editable Excalidraw sketch, kept in
  the browser and exported as `.excalidraw`, PNG or SVG.
- Comments on headings and diagram nodes, carried in share links and
  exported as `<name>.comments.json` sidecars.
- A browser workspace (files, folders, templates, zip import and export)
  and, in Chromium, local folders that reload on change and save on request.
- `docwalk-mcp`, a local MCP server through which a coding agent reads the
  presenter's document, moves the deck and, when allowed, edits it.
- English and Turkish UI.
- An installable app that presents offline after one visit and asks before
  updating.
- Static self-hosting on any host, and full mode on Cloudflare with your
  own GitHub App.
