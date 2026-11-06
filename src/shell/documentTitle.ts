import type { Root } from "mdast";
import { headingText, type SectionPlan } from "../sectioning/sectionize";

/**
 * The title the header shows for a document, or "" when it has none.
 *
 * Usually the first slide's title. A document whose headings open no slide
 * (only `# Title`, or headings with nothing under them) has no slides at
 * all, yet a heading on its first line still names it.
 */
export function documentTitle(root: Root, plan: SectionPlan): string {
  const first = plan.sections[0];
  if (plan.titleHeading || first?.title) return first?.title ?? "";
  const lead = root.children[0];
  return lead?.type === "heading" ? headingText(lead) : "";
}
