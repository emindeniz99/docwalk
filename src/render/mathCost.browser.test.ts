import temml from "temml";
import { describe, expect, test } from "vitest";
import { buildWork, countTree, MAX_BUILD_WORK } from "./mathCost";
import { MathTooLarge } from "./mathRebuild";

/**
 * Decision 101, rule 5: what Temml would do is read off its parse tree and
 * its build tree before the work is done. Temml's parse tree is private
 * ("very likely to change"), so these tests parse real TeX and also pin the
 * list of builders that build a body more than once; an upgrade that adds
 * one shows up in the second group.
 */
const parse = (tex: string) =>
  // oxlint-disable-next-line no-underscore-dangle -- Temml's name for the parse tree API.
  temml.__parse(tex, { throwOnError: true, trust: false, maxExpand: 200, macros: {} });

const nest = (open: string, n: number) => `${open.repeat(n)}x${"}".repeat(n)}`;

describe("buildWork reads the parse tree", () => {
  test("counts a plain formula by its nodes", () => {
    expect(buildWork(parse("a+b"))).toBe(3);
    expect(buildWork(parse("\\frac{a}{b}"))).toBeGreaterThanOrEqual(3);
  });

  test("a text run is as many units as it has characters, far under the limit", () => {
    expect(buildWork(parse(`\\text{${"a".repeat(3000)}}`))).toBeLessThan(MAX_BUILD_WORK);
  });

  test("\\cancelto counts its body three times", () => {
    const once = buildWork(parse("\\cancelto{a}{x+y+z}"));
    const plain = buildWork(parse("\\frac{a}{x+y+z}"));
    expect(once).toBeGreaterThan(plain + 4);
    expect(buildWork(parse(nest("\\cancelto{a}{", 6)))).toBeGreaterThan(3 ** 6);
  });

  test("the lap family counts its body twice", () => {
    expect(buildWork(parse(nest("\\llap{", 10)))).toBeGreaterThan(2 ** 10);
    expect(buildWork(parse(nest("\\mathllap{", 10)))).toBeGreaterThan(2 ** 10);
  });

  test("a stacked arrow counts its labels twice, through the node it shares", () => {
    expect(buildWork(parse(nest("\\equilibriumRight{", 10)))).toBeGreaterThan(2 ** 10);
  });

  test("a bomb stops counting at the limit instead of walking all of it", () => {
    const started = performance.now();
    const work = buildWork(parse(nest("\\cancelto{a}{", 22)));
    expect(work).toBeGreaterThan(MAX_BUILD_WORK);
    expect(performance.now() - started).toBeLessThan(100);
  });

  test("a shared node counted again is still a fast walk", () => {
    // Each level reaches the one below by two paths, so a walk without a memo takes 2^24 steps.
    const started = performance.now();
    expect(buildWork(parse(nest("\\equilibriumRight{", 24)))).toBeGreaterThan(MAX_BUILD_WORK);
    expect(performance.now() - started).toBeLessThan(100);
  });

  test("a macro that repeats its argument is counted after expansion", () => {
    expect(buildWork(parse("\\def\\a#1{#1#1#1#1}\\a{x}"))).toBeLessThan(10);
    expect(buildWork(parse(`\\def\\a{${"x".repeat(320)}}${"\\a".repeat(199)}`))).toBeGreaterThan(
      MAX_BUILD_WORK,
    );
  });
});

describe("countTree reads Temml's build tree", () => {
  const leaf = { children: [{ text: "x" }] };
  const row = (n: number) => ({ children: Array.from({ length: n }, () => leaf) });

  test("counts elements, not text", () => {
    expect(countTree(row(5), { nodes: 100, depth: 10 })).toBe(6);
  });

  test("throws when the tree is wider than the limit, before the rest is walked", () => {
    expect(() => countTree(row(500), { nodes: 100, depth: 10 })).toThrow(MathTooLarge);
  });

  test("throws when the tree is deeper than the limit", () => {
    let deep: object = leaf;
    for (let i = 0; i < 30; i++) deep = { children: [deep] };
    expect(() => countTree(deep, { nodes: 1000, depth: 10 })).toThrow(MathTooLarge);
  });

  test("tolerates a node whose children are not a list", () => {
    expect(countTree({ children: {} }, { nodes: 10, depth: 10 })).toBe(0);
  });
});
