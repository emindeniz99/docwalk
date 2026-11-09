import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  MATH_ATTRIBUTES,
  MATH_CLASSES,
  mathAttributeAllowed,
  mathClasses,
  MATH_ROOT_CLASS,
} from "./mathAllow";

/**
 * Decision 101. The class list is the stylesheet's class list: a class with no
 * rule does nothing, and a class outside the list could be one of the page's
 * own. When Temml is upgraded, a class its stylesheet gains must be added on
 * purpose, and this test is where that shows.
 */
describe("the class allowlist", () => {
  const css = readFileSync(
    new URL("../../node_modules/temml/dist/Temml-Local.css", import.meta.url),
    "utf8",
  )
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/url\((?:"[^"]*"|'[^']*'|[^)]*)\)/g, "");
  const defined = new Set([...css.matchAll(/\.([A-Za-z][\w-]*)/g)].map((m) => m[1]));

  test("holds every class Temml's stylesheet defines, and nothing else", () => {
    expect([...MATH_CLASSES].toSorted()).toEqual([...defined].toSorted());
  });

  test("names no class of the page", () => {
    for (const name of [
      "docwalk-diagram",
      "docwalk-math",
      "present",
      "sr-only",
      "dw-code-keyword",
    ]) {
      expect(MATH_CLASSES.has(name)).toBe(false);
    }
    expect(mathClasses("tml-vec docwalk-diagram  present chr-sml")).toEqual(["tml-vec", "chr-sml"]);
  });

  test("keeps the marker class only on a <math> element", () => {
    expect(mathClasses(`${MATH_ROOT_CLASS} tml-vec present`)).toEqual(["tml-vec"]);
    expect(mathClasses(`${MATH_ROOT_CLASS} tml-vec present`, true)).toEqual([
      MATH_ROOT_CLASS,
      "tml-vec",
    ]);
  });
});

describe("attribute values", () => {
  test("lengths, colours and keywords pass", () => {
    const values = ["0.5em", "-0.2em", "#ff0000", "left right", "true", "100%", "1px"];
    expect(values.filter((value) => !mathAttributeAllowed("width", value))).toEqual([]);
  });

  test("anything that could be a URL, a function or markup fails", () => {
    const values = [
      "url(https://tracker.example/x)",
      "javascript:alert(1)",
      "red;background:blue",
      '"><img src=x>',
      "a\\b",
      "x".repeat(65),
    ];
    expect(values.filter((value) => mathAttributeAllowed("width", value))).toEqual([]);
  });

  test("an attribute off the list fails with any value", () => {
    const names = ["href", "style", "id", "onclick", "src", "xlink:href", "data-x"];
    expect(names.filter((name) => mathAttributeAllowed(name, "1"))).toEqual([]);
    expect(names.filter((name) => MATH_ATTRIBUTES.has(name))).toEqual([]);
  });
});
