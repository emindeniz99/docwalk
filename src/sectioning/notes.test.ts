import { describe, expect, test } from "vitest";
import { isToolDirective, speakerNotes } from "./notes";
import { parseMarkdown, sectionize, type LevelOption } from "./sectionize";

const notesOf = (markdown: string, level: LevelOption = "auto") => {
  const plan = sectionize(parseMarkdown(markdown), level);
  const notes = speakerNotes(plan);
  return {
    ids: plan.sections.map((s) => s.id),
    /** Notes by section id, only for sections that have some. */
    by: Object.fromEntries(notes),
  };
};

describe("which section owns a note", () => {
  test("a comment under a heading is that section's note", () => {
    const { by } = notesOf("# Doc\n\n## One\n\n<!-- Say hello. -->\n\nText.\n\n## Two\n\nMore.\n");
    expect(by).toEqual({ one: ["Say hello."] });
  });

  test("a comment above the next heading stays with the section it follows, as on GitHub", () => {
    const { by } = notesOf(
      "# Doc\n\n## One\n\nText.\n\n<!-- Belongs to One. -->\n\n## Two\n\nMore.\n",
    );
    expect(by).toEqual({ one: ["Belongs to One."] });
  });

  test("a section keeps every comment, in document order", () => {
    const { by } = notesOf("# Doc\n\n## One\n\n<!-- first -->\n\nText.\n\n<!-- second -->\n");
    expect(by).toEqual({ one: ["first", "second"] });
  });

  test("a comment above the cover reaches the cover, not the empty slide it opens", () => {
    // Today a comment above the first heading becomes a slide of its own (`intro`).
    const { ids, by } = notesOf(
      "<!-- Open with the story. -->\n\n# Doc\n\nIntro.\n\n## One\n\nText.\n",
    );
    expect(ids).toEqual(["intro", "doc", "one"]);
    expect(by).toEqual({ doc: ["Open with the story."] });
  });

  test("a comment above the first slide of a document without a cover reaches that slide", () => {
    const { by } = notesOf("<!-- Warm up. -->\n\n## One\n\nText.\n\n## Two\n\nMore.\n");
    expect(by).toEqual({ one: ["Warm up."] });
  });

  test("a comment-only slide with nothing after it keeps its notes", () => {
    const { by } = notesOf("<!-- Only note. -->\n");
    expect(by).toEqual({ intro: ["Only note."] });
  });

  test("a leading slide that also has text keeps its own notes", () => {
    const { by } = notesOf("Opening words.\n\n<!-- Mine. -->\n\n## One\n\nText.\n");
    expect(by).toEqual({ intro: ["Mine."] });
  });

  test("each part after a thematic break is its own section with its own notes", () => {
    const { ids, by } = notesOf(
      "## One\n\n<!-- first part -->\n\nA.\n\n---\n\n<!-- second part -->\n\nB.\n",
    );
    expect(ids).toEqual(["one", "one-part-2"]);
    expect(by).toEqual({ one: ["first part"], "one-part-2": ["second part"] });
  });

  test("a comment in a title-level section belongs to that title slide", () => {
    const { by } = notesOf("# Part\n\n<!-- title note -->\n\nWhy.\n\n## A\n\na\n", 2);
    expect(by).toEqual({ part: ["title note"] });
  });
});

describe("what is a comment", () => {
  test("a comment inside a fenced block or inline code is code, not a note", () => {
    const md =
      "## One\n\n```html\n<!-- in a fence -->\n```\n\nUse `<!-- inline code -->` here.\n\n    <!-- indented code -->\n";
    expect(notesOf(md).by).toEqual({});
  });

  test("a comment inside a paragraph is a note, because GitHub hides it there too", () => {
    expect(notesOf("## One\n\nBefore <!-- inline --> after.\n").by).toEqual({ one: ["inline"] });
  });

  test("a comment in a quote or a list item is a note of the section", () => {
    const md = "## One\n\n> <!-- in quote -->\n> text\n\n- item\n  <!-- in list -->\n";
    expect(notesOf(md).by).toEqual({ one: ["in quote", "in list"] });
  });

  test("several comments in one HTML block, and comments beside other HTML, are all found", () => {
    const md = "## One\n\n<!-- a --> <b>bold</b> <!-- b -->\n\n<div>\n<!-- c -->\n</div>\n";
    expect(notesOf(md).by).toEqual({ one: ["a", "b", "c"] });
  });

  test("a multi-line comment keeps its line breaks and loses its padding", () => {
    expect(notesOf("## One\n\n<!--\nLine one.\n\nLine two.\n-->\n").by).toEqual({
      one: ["Line one.\n\nLine two."],
    });
  });

  test("empty comments are not notes", () => {
    expect(notesOf("## One\n\n<!---->\n\n<!-- -->\n\n<!-->\n\n<!--->\n\nText.\n").by).toEqual({});
  });

  test("a comment ends at --!> as in a browser, so text after it is not part of the note", () => {
    expect(notesOf("## One\n\n<!-- a --!> b -->\n").by).toEqual({ one: ["a"] });
  });

  test("a comment that is never closed is not a note and takes no earlier note down", () => {
    // CommonMark lets it swallow the rest of the document, headings included.
    const { ids, by } = notesOf(
      "## One\n\n<!-- closed -->\n\ntext\n\n<!-- open\n\n## Two\n\nMore.\n",
    );
    expect(ids).toEqual(["one"]);
    expect(by).toEqual({ one: ["closed"] });
  });
});

describe("tool directives are not notes", () => {
  test.each([
    "prettier-ignore",
    "prettier-ignore-start",
    "prettier-ignore-end",
    "markdownlint-disable MD033",
    "markdownlint-disable-next-line MD013",
    'markdownlint-configure-file { "MD013": false }',
    "eslint-disable",
    "eslint-enable no-console",
    "textlint-disable",
    "cspell:disable-next-line",
    "cspell:words wibble",
    "toc",
    "TOC",
    "/toc",
    "tocstop",
    "  prettier-ignore  ",
  ])("%j is a directive", (text) => {
    expect(isToolDirective(text)).toBe(true);
  });

  test.each([
    "Say hello",
    "Mention prettier-ignore only if asked",
    "tocopherol is vitamin E",
    "token budget",
    "eslint is great",
    "markdownlint",
    "cspell",
    "",
  ])("%j is a note", (text) => {
    expect(isToolDirective(text)).toBe(false);
  });

  test("a section's directives are dropped and its real notes stay", () => {
    const md =
      "<!-- markdownlint-disable MD041 -->\n\n## One\n\n<!-- prettier-ignore -->\n\n<!-- Real note. -->\n";
    const { by } = notesOf(md);
    expect(by).toEqual({ one: ["Real note."] });
  });

  test("a leading slide holding only directives hands nothing on and loses nothing", () => {
    expect(notesOf("<!-- eslint-disable -->\n\n## One\n\nText.\n").by).toEqual({});
  });
});

describe("hostile comment text stays text", () => {
  test("markup inside a comment comes back as the characters it is", () => {
    const hostile = '<img src=x onerror="alert(1)"> </section><script>alert(2)</script>';
    const { by } = notesOf(`## One\n\n<!-- ${hostile} -->\n\n## Two\n\nText.\n`);
    expect(by).toEqual({ one: [hostile] });
  });

  test("an end tag in a comment does not close the section or leak to the next one", () => {
    const { by } = notesOf("## One\n\n<!-- </section></div> -->\n\ntext\n\n## Two\n\ntext\n");
    expect(by).toEqual({ one: ["</section></div>"] });
  });
});
