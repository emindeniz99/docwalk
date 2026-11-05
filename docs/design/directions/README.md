# Design directions

Mockups from the 2026-11-05 design exploration, kept as the record behind
decision 49 in [`../../decisions.md`](../../decisions.md). They are sources
for a Claude Design canvas (`canvas.json` is its layout; each `*.dc.html`
is one artboard), so they render inside that editor rather than as plain
web pages. All content is the synthetic Ledgerline fixture.

| Files | Direction |
|---|---|
| `Main.dc.html`, `A-present.dc.html` | A · Familiar: GitHub-like, document first |
| `B-editor.dc.html`, `B-present.dc.html` | B · Stage: presentation first, white slide on a dark stage |
| `C-editor.dc.html`, `C-present.dc.html` | C · Workbench: dense, dark, keyboard first |
| `D-focus.dc.html`, `D-mobile.dc.html` | Diagram focus with pen and laser; presenting on a phone (Stage look) |
| `E-editor.dc.html` | The chosen editor: Stage layout with Workbench tools |

The chosen mix is Stage for presenting, `E-editor` for editing and Familiar
for document mode. The mockups load fonts from Google Fonts because the
canvas needs them; the app itself self-hosts its fonts (decision 51).
[`../../../DESIGN.md`](../../../DESIGN.md) is the source of truth; these
files are history and are not kept in sync with it.
