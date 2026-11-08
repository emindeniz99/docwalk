import { describe, expect, test } from "vitest";
import { applySelection } from "./selection";
import { parseMarkdown, sectionize } from "./sectionize";

const DOC = [
  "# Plan",
  "",
  "## Alpha",
  "",
  "First.[^n]",
  "",
  "## Beta",
  "",
  "Second.",
  "",
  "---",
  "",
  "More of beta.",
  "",
  "## Gamma",
  "",
  "Third.",
  "",
  "## Delta",
  "",
  "Fourth.",
  "",
  "[^n]: A footnote that lives in the last section's neighbourhood.",
  "",
].join("\n");

const plan = sectionize(parseMarkdown(DOC));
const ids = (result: { plan: { sections: { id: string }[] } }) =>
  result.plan.sections.map((s) => s.id);

describe("applySelection", () => {
  test("no selection presents every section, and the plan is the same object so nothing rebuilds", () => {
    const result = applySelection(plan, null);
    expect(result.status).toBe("all");
    expect(result.plan).toBe(plan);
    expect(ids(result)).toEqual(ids({ plan }));
  });

  test("an empty list is no selection, because nothing chosen cannot mean an empty deck", () => {
    expect(applySelection(plan, []).status).toBe("all");
    expect(applySelection(plan, []).plan).toBe(plan);
  });

  test("chosen sections are kept in document order whatever order the link lists them", () => {
    const result = applySelection(plan, ["delta", "alpha"]);
    expect(result.status).toBe("some");
    expect(ids(result)).toEqual(["alpha", "delta"]);
    expect([...result.chosen]).toEqual(["alpha", "delta"]);
    expect(result.total).toBe(plan.sections.length);
  });

  test("an id the document does not have is ignored without a trace, so an old link survives an edit", () => {
    const result = applySelection(plan, ["beta", "removed-in-an-edit", "gamma"]);
    expect(result.status).toBe("some");
    expect(ids(result)).toEqual(["beta", "gamma"]);
  });

  test("when none of the chosen ids exist every section is shown and the status says so", () => {
    const result = applySelection(plan, ["gone", "also-gone"]);
    expect(result.status).toBe("unknown");
    expect(result.plan).toBe(plan);
    expect(ids(result)).toEqual(ids({ plan }));
  });

  test("choosing every section is the same as choosing none, so the whole deck is not marked as a subset", () => {
    const everything = plan.sections.map((s) => s.id);
    const result = applySelection(plan, everything);
    expect(result.status).toBe("all");
    expect(result.plan).toBe(plan);
  });

  test("a part after a thematic break is its own section and is chosen on its own", () => {
    const parts = plan.sections.map((s) => s.id).filter((id) => id.startsWith("beta"));
    expect(parts).toHaveLength(2);
    const onlySecond = applySelection(plan, [parts[1]!]);
    expect(ids(onlySecond)).toEqual([parts[1]]);
  });

  test("the plan keeps its levels, title heading, anchors and definitions, so footnotes and links still resolve on a kept slide", () => {
    const result = applySelection(plan, ["alpha"]);
    expect(result.plan.levels).toEqual(plan.levels);
    expect(result.plan.titleHeading).toBe(plan.titleHeading);
    expect(result.plan.headingIds).toBe(plan.headingIds);
    expect(result.plan.definitions).toBe(plan.definitions);
    // The footnote definition sits after the last section but belongs to "alpha".
    expect(result.plan.definitions).toHaveLength(1);
  });

  test("the input plan is not changed, so the document view and the outline keep every section", () => {
    const before = ids({ plan });
    applySelection(plan, ["gamma"]);
    expect(ids({ plan })).toEqual(before);
  });

  test("a repeated id counts once", () => {
    expect(ids(applySelection(plan, ["gamma", "gamma", "alpha"]))).toEqual(["alpha", "gamma"]);
  });

  test("ids are compared as written, so a Unicode heading is chosen by its own anchor", () => {
    const unicode = sectionize(parseMarkdown("# T\n\n## Çalışma planı\n\nx\n\n## 日本語\n\ny\n"));
    const result = applySelection(unicode, ["日本語"]);
    expect(ids(result)).toEqual(["日本語"]);
  });
});
