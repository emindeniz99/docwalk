import { describe, expect, test } from "vitest";
import { exportHtml } from "../export/html";
import { nodesToHtml } from "../render/toHtml";
import { parseMarkdown, sectionize } from "../sectioning/sectionize";
import { buildSlides } from "./slides";

/**
 * Speaker notes (decision 79) are for the presenter window only. The same
 * comment text must not reach anything else the document produces: the
 * audience's slides, document mode or an export. Each surface is rendered
 * here from Markdown that carries a note and a directive, and none may hold
 * their text or even a comment.
 */
const NOTE = "Say the secret launch date aloud.";
const MULTI = "Second note line one.\nSecond note line two.";
const DIRECTIVE = "markdownlint-disable MD033";
const MARKDOWN = [
  `<!-- ${DIRECTIVE} -->`,
  "",
  "# Deck",
  "",
  "Intro.",
  "",
  "## Alpha",
  "",
  `<!-- ${NOTE} -->`,
  "",
  "Visible text.",
  "",
  `<!--\n${MULTI}\n-->`,
  "",
  "Inline <!-- inline note --> text.",
].join("\n");
const HIDDEN = [NOTE, "Second note line", DIRECTIVE, "inline note", "<!--", "-->"];

describe("speaker notes stay in the presenter window", () => {
  test("the audience's slides carry no note text and no comment", () => {
    const slides = buildSlides(sectionize(parseMarkdown(MARKDOWN), "auto"));
    const html = slides.map((s) => s.outerHTML).join("\n");
    expect(html).toContain("Visible text.");
    for (const text of HIDDEN) expect(html).not.toContain(text);
  });

  test("document mode shows no note text and no comment", () => {
    const html = nodesToHtml(parseMarkdown(MARKDOWN).children);
    expect(html).toContain("Visible text.");
    for (const text of HIDDEN) expect(html).not.toContain(text);
  });

  test("an HTML export holds no note text and no comment", async () => {
    const slides = buildSlides(sectionize(parseMarkdown(MARKDOWN), "auto")).map((element) => ({
      address: `${element.dataset["docwalkId"]}/1`,
      title: element.dataset["title"] ?? "",
      element,
    }));
    const text = await (
      await exportHtml({ title: "Deck", slides, size: { width: 1280, height: 720 } })
    ).text();
    expect(text).toContain("Visible text.");
    for (const hidden of HIDDEN) expect(text).not.toContain(hidden);
  });
});
