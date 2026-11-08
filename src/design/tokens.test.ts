import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { parse } from "yaml";
import { tokensToCss } from "./css";
import { tokens } from "./tokens";

const root = fileURLToPath(new URL("../../", import.meta.url));
const designMd = readFileSync(join(root, "DESIGN.md"), "utf8");
const frontMatter = parse(designMd.split(/^---$/m)[1] ?? "") as Record<string, unknown>;

describe("DESIGN.md and src/design/tokens.ts stay equal", () => {
  // Two hand-kept copies of the same values drift apart when nothing compares
  // them; this test is the comparison. It fails on a token missing on either
  // side as well as on a changed value.
  for (const group of ["colors", "typography", "rounded", "spacing"] as const) {
    test(`${group}: same names and values in both`, () => {
      expect(frontMatter[group]).toEqual(tokens[group]);
    });
  }

  test("every component token in DESIGN.md references a token that exists", () => {
    const components = frontMatter["components"] as Record<string, Record<string, string>>;
    for (const [name, props] of Object.entries(components)) {
      for (const value of Object.values(props)) {
        const ref = /^\{(\w+)\.([\w-]+)\}$/.exec(String(value));
        if (!ref) continue;
        const [, group, key] = ref;
        expect(
          (frontMatter[group as string] as Record<string, unknown>)?.[key as string],
          `${name} -> ${value}`,
        ).toBeDefined();
      }
    }
  });
});

describe("raw colours live only in the token module", () => {
  const HEX = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|oklch)\(/g;
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(css|ts|tsx)$/.test(entry) && !entry.endsWith(".test.ts")) files.push(path);
    }
  };
  walk(join(root, "src"));

  test("no file under src/ except tokens.ts contains a hex, rgb(), hsl() or oklch() colour", () => {
    const offenders = files
      .filter((f) => !f.replaceAll("\\", "/").endsWith("design/tokens.ts"))
      .flatMap((f) =>
        (readFileSync(f, "utf8").match(HEX) ?? []).map((hex) => `${relative(root, f)}: ${hex}`),
      );
    expect(offenders).toEqual([]);
  });
});

describe("generated CSS", () => {
  test("every colour token becomes a custom property", () => {
    const css = tokensToCss();
    for (const name of Object.keys(tokens.colors)) expect(css).toContain(`--dw-color-${name}:`);
  });
});
