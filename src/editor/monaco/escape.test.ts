import { describe, expect, test } from "vitest";
import { escapeMarkdown } from "./escape";

describe("escapeMarkdown (Monaco hover messages)", () => {
  test("an image or link quoted from the document stays text, so nothing loads or navigates", () => {
    // Diagnostics can quote headings; a heading is attacker-controlled.
    expect(escapeMarkdown("![t](https://example.invalid/p.png)")).toBe(
      "\\!\\[t\\]\\(https\\:\\/\\/example\\.invalid\\/p\\.png\\)",
    );
    expect(escapeMarkdown("<img src=x onerror=alert(1)>")).not.toMatch(/(^|[^\\])</);
  });

  test("plain words and line breaks pass through, so the note reads as written", () => {
    expect(escapeMarkdown("Too tall for a slide\n\nSecond note")).toBe(
      "Too tall for a slide\n\nSecond note",
    );
  });

  test("every ASCII punctuation mark is escaped, leaving no Markdown syntax", () => {
    const punctuation = "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~";
    const escaped = escapeMarkdown(punctuation);
    expect(escaped).toBe([...punctuation].map((c) => `\\${c}`).join(""));
  });
});
