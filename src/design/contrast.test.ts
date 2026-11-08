import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { parse } from "yaml";
import { tokens } from "./tokens";

const root = new URL("../../", import.meta.url).pathname;
const frontMatter = parse(
  readFileSync(join(root, "DESIGN.md"), "utf8").split(/^---$/m)[1] ?? "",
) as { components: Record<string, Record<string, string>> };

/** WCAG 2.2 relative luminance of a `#rrggbb` colour. */
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].toSorted((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const tokenName = (ref: string) => /^\{colors\.([\w-]+)\}$/.exec(ref)?.[1] ?? "";
const colour = (ref: string) => (tokens.colors as Record<string, string>)[tokenName(ref)] ?? "";

describe("text colours stay readable on the surface they are drawn on", () => {
  // design.md lint only warns on a low pair; text a viewer cannot read is a
  // defect (WCAG 2.2 AA, decision 41), so a pair below 4.5:1 fails here.
  const pairs = Object.entries(frontMatter.components).filter(
    ([, c]) => c["backgroundColor"] && c["textColor"],
  );

  test.each(pairs)("%s passes 4.5:1", (_name, component) => {
    const bg = colour(component["backgroundColor"] ?? "");
    const fg = colour(component["textColor"] ?? "");
    expect(bg, "background is a hex token").toMatch(/^#[0-9a-f]{6}$/);
    expect(fg, "text is a hex token").toMatch(/^#[0-9a-f]{6}$/);
    expect(contrast(bg, fg)).toBeGreaterThanOrEqual(4.5);
  });

  test("every code colour is checked on its block, in both themes", () => {
    // A code token added to tokens.ts without a component here would never
    // be checked by the test above.
    const checked = new Set(pairs.map(([, c]) => tokenName(c["textColor"] ?? "")));
    const code = Object.keys(tokens.colors).filter(
      (name) => name.startsWith("code-") && !name.includes("surface"),
    );
    expect(code.length).toBeGreaterThan(0);
    expect(code.filter((name) => !checked.has(name))).toEqual([]);
  });
});

describe("a marked code line in the focus view (decision 87)", () => {
  // The focus view's ground is the slide white and a marked line takes the note
  // fill, so every colour a token can have must still read on it.
  const colors = tokens.colors as Record<string, string>;
  const onMark = ["keyword", "string", "comment", "constant", "function", "parameter"];

  test.each(onMark)("code-%s passes 4.5:1 on the note fill", (kind) => {
    expect(
      contrast(colors[`code-${kind}`] ?? "", colors["note-surface"] ?? ""),
    ).toBeGreaterThanOrEqual(4.5);
  });

  test("plain code text passes 4.5:1 on the note fill", () => {
    expect(
      contrast(colors["slide-ink"] ?? "", colors["note-surface"] ?? ""),
    ).toBeGreaterThanOrEqual(4.5);
  });

  test("the bar beside a marked line passes 3:1 on the slide white", () => {
    expect(contrast(colors["note-ink"] ?? "", colors["slide"] ?? "")).toBeGreaterThanOrEqual(3);
  });
});
