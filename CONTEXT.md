# CONTEXT.md: docwalk glossary

The words this project uses in code, docs, commits and the UI. One entry per
term, alphabetical. Numbers refer to rows in `docs/decisions.md`.

## Terms

**Atomic block**: a rendered block pagination never splits: a code block, a
Mermaid diagram, an image. One taller than an empty slide gets a
**diagnostic** (19).

**Base level**: the heading level that starts slides. `auto` picks it with
Pandoc's rule, skipping the **document title** (14); the user can override
it (20). Code: `SectionPlan.levels`.

**Document title**: the only H1, when it comes before every other heading.
It becomes the cover slide. Code: `findTitleHeading`.

**Breadcrumb**: the trail of parent headings shown on a slide, such as
`Failure handling › Retries` (15, 17).

**Continuation slide**: a slide pagination created from an overflowing
section. Its title carries "· continued"; a table on it repeats its header
(18).

**Diagnostic**: a visible warning that content does not fit or cannot be
rendered. docwalk shows one instead of clipping or shrinking (19).

**Diagram focus**: the mode a click on a Mermaid diagram opens: fit, zoom,
pan, reset, fullscreen, pen and laser (3, 28, 29).

**Document mode**: the doc rendered as GitHub would show it, scrolling, no
slides (3, 10).

**Full mode**: a deployment with the Worker, so `/api` exists: OAuth and,
from v1.1, remote control (37, 38). Opposite: **static mode**.

**Measurement pass**: the post-render check of a slide and each Mermaid host
for overflow, run in the order of decision 22.

**Section**: the part of the AST between two slide starts at the base level.
One section yields one or more **slides**. Its id comes from the heading
slug and is stable across viewports (21); a heading with an empty slug
gets a **fallback address**, `heading-<hex code points>` (62). Code:
`headingIds`.

**Slide**: one screen in presentation mode, addressed as `<section-id>/<n>`
(21).

**Slide overview**: the grid of every slide's thumbnail, opened with O or
the grid button; Enter jumps to a slide. It replaces reveal.js's own
overview. Code: `SlideOverview`.

**Static mode**: a deployment without the Worker. Everything except OAuth
and remote control works (37, 38).

**Title slide**: a slide for a heading above the base level that has its own
content (15).
