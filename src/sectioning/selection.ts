import type { SectionPlan } from "./sectionize";

/**
 * - `all`: no choice, or a choice of every section; the plan is the input.
 * - `some`: a proper subset of the document's sections.
 * - `unknown`: ids were chosen but the document has none of them (an edit
 *   removed or renamed them); the whole document is shown and the viewer is
 *   told why.
 */
type SelectionStatus = "all" | "some" | "unknown";

interface SelectionResult {
  status: SelectionStatus;
  /** What the deck is built from: the input itself for `all` and `unknown`. */
  plan: SectionPlan;
  /** Ids of the sections the plan presents, in document order. */
  chosen: ReadonlySet<string>;
  /** How many sections the document has. */
  total: number;
}

/**
 * Keeps the chosen sections of `plan` (decision 100), in document order
 * whatever order the link lists them. Only `sections` is cut: the levels, the
 * title heading, the heading anchors and the definitions stay, so a footnote
 * or an in-page link on a kept slide still resolves. The input is not changed.
 */
export function applySelection(plan: SectionPlan, ids: readonly string[] | null): SelectionResult {
  const total = plan.sections.length;
  const everything = (status: SelectionStatus): SelectionResult => ({
    status,
    plan,
    chosen: new Set(plan.sections.map((section) => section.id)),
    total,
  });
  // An empty document has nothing to match yet: it is loading, or empty.
  if (ids === null || ids.length === 0 || total === 0) return everything("all");

  const wanted = new Set(ids);
  const kept = plan.sections.filter((section) => wanted.has(section.id));
  if (kept.length === 0) return everything("unknown");
  if (kept.length === total) return everything("all");
  return {
    status: "some",
    plan: { ...plan, sections: kept },
    chosen: new Set(kept.map((section) => section.id)),
    total,
  };
}
