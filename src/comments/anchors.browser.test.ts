import { afterEach, expect, test } from "vitest";
import { purifyHtml } from "../deck/purify";
import { anchorTarget } from "../render/fragments";
import { nodesToHtml } from "../render/toHtml";
import { parseMarkdown, sectionize } from "../sectioning/sectionize";
import { buildAnchorIndex } from "./anchors";

/**
 * A heading's comment anchor is the id the renderer writes on it (decision
 * 132), so the slide marker and "Show on slide" find the heading. Two
 * headings without a GitHub slug must each find their own.
 */

let mounted: HTMLElement | null = null;
afterEach(() => mounted?.remove());

test("every heading's anchor finds that heading in the rendered page, empty GitHub slugs included", () => {
  const markdown = "# Ledger\n\n## ???\n\nOne.\n\n## ???\n\nTwo.\n\n## 🚀\n\nThree.\n\n## Goals\n";
  const root = parseMarkdown(markdown);
  const plan = sectionize(root);
  const index = buildAnchorIndex(root, plan);
  mounted = document.createElement("article");
  mounted.append(purifyHtml(nodesToHtml(root.children, { headingIds: plan.headingIds })));
  document.body.append(mounted);

  const found = index.headings.map((h) => anchorTarget(mounted!, h.slug));
  const rendered = [...mounted.querySelectorAll("h1, h2")];
  expect(rendered).toHaveLength(5);
  expect(found).toEqual(rendered);
  expect(new Set(index.headings.map((h) => h.slug)).size).toBe(5);
});
