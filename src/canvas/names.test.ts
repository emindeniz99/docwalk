import { describe, expect, test } from "vitest";
import { sketchFileName } from "./names";

describe("sketch export names (decision 98)", () => {
  test("the diagram's number and the document's title name the file", () => {
    expect(sketchFileName("Ledgerline: Payment Ledger", 2, "flowchart")).toBe(
      "ledgerline-payment-ledger-diagram-2",
    );
  });

  test("without a number the diagram type names it, as a slug, so a hostile first word adds no path", () => {
    // The type is the first word of the diagram's source, which anyone can write.
    expect(sketchFileName("Doc", null, "../../etc/passwd")).toBe("doc-diagram-etc-passwd");
    expect(sketchFileName("Doc", null, 'a"b\\c:d.exe')).toBe("doc-diagram-a-b-c-d-exe");
  });

  test("an empty title and a type with no letters fall back to plain words", () => {
    expect(sketchFileName("", null, "***")).toBe("docwalk-diagram-diagram");
  });
});
