import { describe, expect, test } from "vitest";
import {
  TEXT_MATCH_LIMIT,
  TEXT_MIN_QUERY,
  findText,
  normalizeQuery,
  searchText,
  snippetAround,
  titleMatches,
} from "./slideSearch";

const EN = "en-US";
const TR = "tr-TR";

/** The matched slice of `text`, or null: what a reader would see highlighted. */
function found(text: string, query: string, locale = EN): string | null {
  const hit = findText(text, query, locale);
  return hit ? text.slice(hit.start, hit.end) : null;
}

describe("normalizeQuery: what the palette searches for", () => {
  test("trims the ends and folds runs of whitespace, so a query can span a line break in the page", () => {
    expect(normalizeQuery("  retry \t  budget\n")).toBe("retry budget");
  });

  test("a blank query becomes empty, so it matches nothing", () => {
    expect(normalizeQuery(" \n\t ")).toBe("");
  });

  test("composes accents the way page text does, so é typed as e + U+0301 still matches", () => {
    expect(normalizeQuery("café")).toBe("café");
  });
});

describe("findText: case, accents and boundaries", () => {
  test("ignores case in both directions", () => {
    expect(found("Where retries happen", "RETRIES")).toBe("retries");
    expect(found("Where RETRIES happen", "retries")).toBe("RETRIES");
  });

  test("ignores accents in both directions, as the title filter does", () => {
    expect(found("A quiet café by the river", "cafe")).toBe("café");
    expect(found("A quiet cafe by the river", "CAFÉ")).toBe("cafe");
  });

  test("returns the position of the first match, in the text's own indices", () => {
    expect(findText("one two two", "two", EN)).toEqual({ start: 4, end: 7 });
  });

  test("finds a match at the very start and at the very end of the text", () => {
    expect(findText("retries are bounded", "retries", EN)).toEqual({ start: 0, end: 7 });
    expect(findText("bounded retries", "retries", EN)).toEqual({ start: 8, end: 15 });
  });

  test("finds a text that is exactly the query", () => {
    expect(findText("retries", "retries", EN)).toEqual({ start: 0, end: 7 });
  });

  test("finds nothing when the query is longer than the text", () => {
    expect(findText("retr", "retries", EN)).toBeNull();
  });

  test("finds nothing for an empty query or empty text", () => {
    expect(findText("retries", "", EN)).toBeNull();
    expect(findText("", "retries", EN)).toBeNull();
  });

  test("matches a phrase across the single space that replaced a line break", () => {
    expect(found("The retry budget is five.", "retry budget")).toBe("retry budget");
  });

  test("keeps the offset right when the page text holds an emoji before the match", () => {
    const text = "Done \u{1F680} then retries";
    const hit = findText(text, "retries", EN);
    expect(hit && text.slice(hit.start, hit.end)).toBe("retries");
  });
});

describe("findText: Turkish dotted and dotless i (decision 81)", () => {
  test("in the Turkish UI, I finds dotless ı and i finds dotted İ", () => {
    expect(found("sıra ışık", "IŞIK", TR)).toBe("ışık");
    expect(found("İstanbul", "istanbul", TR)).toBe("İstanbul");
    expect(found("istanbul", "İSTANBUL", TR)).toBe("istanbul");
  });

  test("in the Turkish UI, I does not find i and i does not find ı", () => {
    expect(found("listing", "LISTING", TR)).toBeNull();
    expect(found("sıra", "sira", TR)).toBeNull();
  });

  test("in the English UI, dotted İ matches i and I, while dotless ı stays a letter of its own", () => {
    expect(found("İstanbul", "istanbul", EN)).toBe("İstanbul");
    expect(found("İstanbul", "ISTANBUL", EN)).toBe("İstanbul");
    expect(found("sıra", "sira", EN)).toBeNull();
  });

  test("the Turkish collation keeps ç ğ ö ş ü as letters, the English one does not", () => {
    // Same rule as the title filter: this documents it, so a change shows up here first.
    expect(found("geçiyordu", "geciyordu", TR)).toBeNull();
    expect(found("geçiyordu", "geçiyordu", TR)).toBe("geçiyordu");
    expect(found("geçiyordu", "geciyordu", EN)).toBe("geçiyordu");
  });
});

describe("findText: hostile text", () => {
  test("markup in the page is plain characters to the search", () => {
    const text = 'Try <img src=x onerror="alert(1)"> then </section><script>x()</script> done';
    expect(found(text, "onerror")).toBe("onerror");
    expect(found(text, "<script>")).toBe("<script>");
  });

  test("regex and glob characters in the query are literal", () => {
    expect(found("a (b) [c] d.*e", ".*")).toBe(".*");
    expect(found("a (b) [c] d.*e", "(b")).toBe("(b");
    expect(found("abc", ".*")).toBeNull();
    expect(found("abc", "a|b")).toBeNull();
  });

  test("control characters and lone surrogates in the page do not throw", () => {
    const text = `a\u0000b \ud800 c \udc00 d retries`;
    expect(found(text, "retries")).toBe("retries");
    expect(() => findText(text, "\ud800", EN)).not.toThrow();
  });
});

/** How many times the code under test reached for a collator's `compare`. */
function countCompares(run: () => void): number {
  let count = 0;
  const descriptor = Object.getOwnPropertyDescriptor(Intl.Collator.prototype, "compare")!;
  Object.defineProperty(Intl.Collator.prototype, "compare", {
    ...descriptor,
    get(this: Intl.Collator) {
      count++;
      return descriptor.get!.call(this);
    },
  });
  try {
    run();
  } finally {
    Object.defineProperty(Intl.Collator.prototype, "compare", descriptor);
  }
  return count;
}

describe("findText: a hostile 2 MB document (decision 116)", () => {
  // The palette searches on every keystroke, on the main thread. A collator
  // call at every position of a 2 MB page froze the tab for seconds.
  const BIG = "Lorem ipsum dolor sit amet, café İstanbul ışık. ".repeat(44_000);

  test("the document is the size the finding names", () => {
    expect(BIG.length).toBeGreaterThan(2_000_000);
  });

  test("a query that matches nowhere costs a collator call per distinct letter, not per position", () => {
    const calls = countCompares(() => expect(findText(BIG, "zzqq", EN)).toBeNull());
    expect(calls).toBeLessThan(200);
  });

  test("a match at the very end is still found, at the right place, in both locales", () => {
    const text = `${BIG}the retry budget`;
    expect(findText(text, "RETRY BUDGET", EN)).toEqual({ start: BIG.length + 4, end: text.length });
    expect(found(text, "ISTANBUL", EN)).toBe("İstanbul");
    expect(found(text, "IŞIK", TR)).toBe("ışık");
  });

  test("searchText folds each slide once: the next keystroke calls no collator at all", () => {
    const deck = [slide(0, BIG), slide(1, `${BIG} retries`)];
    searchText(deck, "re", EN, () => false);
    const calls = countCompares(() => {
      const { hits } = searchText(deck, "retries", EN, () => false);
      expect(hits.map((h) => h.slide.n)).toEqual([1]);
    });
    expect(calls).toBe(0);
  });
});

describe("findText: folding keeps the collator's verdicts", () => {
  test("a fullwidth letter matches its ASCII form, as the collator says", () => {
    expect(found("ＡＢＣ report", "abc")).toBe("ＡＢＣ");
  });

  test("katakana matches hiragana at base sensitivity, as the collator says", () => {
    expect(found("カタカナ", "かたかな")).toBe("カタカナ");
  });

  test("a match never ends inside a surrogate pair", () => {
    expect(findText("\u{1F680}", "\ud83d", EN)).toBeNull();
  });
});

describe("snippetAround: the text shown under a hit", () => {
  const WORDS = Array.from({ length: 60 }, (_, i) => `word${i}`).join(" ");

  test("a short text comes back whole, with the match marked and no ellipsis", () => {
    const text = "The retry budget is five.";
    const hit = findText(text, "retry", EN)!;
    expect(snippetAround(text, hit)).toEqual({
      before: "The ",
      match: "retry",
      after: " budget is five.",
    });
  });

  test("a long text is cut with an ellipsis on each open side", () => {
    const hit = findText(WORDS, "word30", EN)!;
    const s = snippetAround(WORDS, hit);
    expect(s.match).toBe("word30");
    expect(s.before.startsWith("…")).toBe(true);
    expect(s.after.endsWith("…")).toBe(true);
    // About 40 before and 60 after, plus the ellipses.
    expect(s.before.length).toBeLessThanOrEqual(42);
    expect(s.after.length).toBeLessThanOrEqual(62);
  });

  test("cuts at word boundaries, never in the middle of a word", () => {
    const hit = findText(WORDS, "word30", EN)!;
    const s = snippetAround(WORDS, hit);
    const words = (s.before + s.match + s.after).replaceAll("…", "").trim().split(" ");
    for (const w of words) expect(w).toMatch(/^word\d+$/);
  });

  test("a match at the start has no leading ellipsis; one at the end has no trailing one", () => {
    const start = snippetAround(WORDS, findText(WORDS, "word0", EN)!);
    expect(start.before).toBe("");
    expect(start.after.endsWith("…")).toBe(true);
    const end = snippetAround(WORDS, findText(WORDS, "word59", EN)!);
    expect(end.before.startsWith("…")).toBe(true);
    expect(end.after).toBe("");
  });

  test("one very long word is cut where it stands and never splits an emoji", () => {
    const text = `${"\u{1F680}".repeat(100)}retries${"\u{1F680}".repeat(100)}`;
    const s = snippetAround(text, findText(text, "retries", EN)!);
    expect(s.match).toBe("retries");
    const all = s.before + s.after;
    // A lone surrogate would show as U+FFFD or a broken glyph.
    expect(all.replaceAll("…", "")).toMatch(/^(?:\u{1F680})*(?:\u{1F680})*$/u);
  });

  test("markup stays text: the snippet holds the raw characters and nothing else", () => {
    const text = 'before <img src=x onerror="alert(1)"> after';
    const s = snippetAround(text, findText(text, "onerror", EN)!);
    expect(s.before + s.match + s.after).toBe(text);
  });
});

const slide = (n: number, text: string) => ({ n, text });

describe("searchText: which slides answer a query", () => {
  const deck = [
    slide(0, "Intro and goals"),
    slide(1, "The adapter retries on its own"),
    slide(2, "No match here"),
    slide(3, "Budget for retries is five"),
  ];

  test("returns matching slides in deck order, each with its snippet", () => {
    const { hits, total } = searchText(deck, "retries", EN, () => false);
    expect(hits.map((h) => h.slide.n)).toEqual([1, 3]);
    expect(hits[0]?.snippet.match).toBe("retries");
    expect(total).toBe(2);
  });

  test("skips slides the caller already lists, so a title hit is not repeated", () => {
    const { hits } = searchText(deck, "retries", EN, (s) => s.n === 1);
    expect(hits.map((h) => h.slide.n)).toEqual([3]);
  });

  test("an empty or one-character query searches nothing", () => {
    expect(TEXT_MIN_QUERY).toBe(2);
    expect(searchText(deck, "", EN, () => false)).toEqual({ hits: [], total: 0 });
    expect(searchText(deck, "r", EN, () => false)).toEqual({ hits: [], total: 0 });
    expect(searchText(deck, "   ", EN, () => false)).toEqual({ hits: [], total: 0 });
  });

  test("caps the list but still reports how many slides matched", () => {
    const many = Array.from({ length: TEXT_MATCH_LIMIT + 7 }, (_, i) => slide(i, "retries here"));
    const { hits, total } = searchText(many, "retries", EN, () => false);
    expect(hits).toHaveLength(TEXT_MATCH_LIMIT);
    expect(hits.map((h) => h.slide.n)).toEqual(
      Array.from({ length: TEXT_MATCH_LIMIT }, (_, i) => i),
    );
    expect(total).toBe(TEXT_MATCH_LIMIT + 7);
  });

  test("does not count skipped slides in the total", () => {
    const { total } = searchText(deck, "retries", EN, () => true);
    expect(total).toBe(0);
  });
});

/**
 * React Aria's `useFilter({ sensitivity: "base" }).contains`, which the palette's title filter used
 * before decision 123: a collator window the length of the query, slid along the title.
 */
function ariaContains(title: string, query: string, locale: string): boolean {
  if (query.length === 0) return true;
  const collator = new Intl.Collator(locale, { usage: "search", sensitivity: "base" });
  const t = title.normalize("NFC");
  const q = query.normalize("NFC");
  for (let at = 0; at + q.length <= t.length; at++) {
    if (collator.compare(q, t.slice(at, at + q.length)) === 0) return true;
  }
  return false;
}

describe("titleMatches: the palette's title filter (decision 123)", () => {
  // Each case is a verdict the title filter gave before this row; a change of matching shows up here.
  const cases: [title: string, query: string, locale: string][] = [
    ["Failure handling", "FAIL", EN],
    ["Failure handling", "handling", EN],
    ["Failure handling", "rollout", EN],
    ["Café notes", "cafe", EN],
    ["Cafe notes", "CAFÉ", EN],
    ["Cafe\u0301 notes", "café", EN],
    ["İstanbul", "istanbul", EN],
    ["İstanbul", "ISTANBUL", EN],
    ["sıra", "sira", EN],
    ["İstanbul", "istanbul", TR],
    ["Işık", "IŞIK", TR],
    ["listing", "LISTING", TR],
    ["geçiyordu", "gec", TR],
    ["geçiyordu", "gec", EN],
    ["Rollout · 2", "out · 2", EN],
    ["Rollout", " roll", EN],
    ["Rollout", "", EN],
    ["", "a", EN],
    ["ＡＢＣ report", "abc", EN],
    ["カタカナ", "かたかな", EN],
  ];

  test.each(cases)(
    "%j against %j in %s gives the verdict React Aria's filter gave",
    (title, query, locale) => {
      expect(titleMatches(title, query, locale)).toBe(ariaContains(title, query, locale));
    },
  );

  test("the cases cover both verdicts in both locales, so the check above can fail", () => {
    const verdicts = cases.map(([t, q, l]) => `${l}:${ariaContains(t, q, l)}`);
    expect(new Set(verdicts)).toEqual(
      new Set(["en-US:true", "en-US:false", "tr-TR:true", "tr-TR:false"]),
    );
  });

  test("an empty query matches every title, so the palette lists every slide while the box is empty", () => {
    expect(titleMatches("Anything", "", EN)).toBe(true);
  });
});

describe("titleMatches: a hostile 2 MB heading (decision 123)", () => {
  // A heading has no length cap, and the title filter runs for every slide on every keystroke.
  const BIG = "Lorem ipsum dolor sit amet, café İstanbul ışık. ".repeat(44_000);

  test("a query that matches nowhere costs a collator call per distinct letter, not per position", () => {
    // React Aria's window made one call per position: two million for this heading.
    const calls = countCompares(() => expect(titleMatches(BIG, "zzqq", EN, {})).toBe(false));
    expect(calls).toBeLessThan(200);
  });

  test("a heading is folded once per deck: the next keystroke calls no collator at all", () => {
    const owner = {};
    titleMatches(`${BIG}the end`, "th", EN, owner);
    const calls = countCompares(() =>
      expect(titleMatches(`${BIG}the end`, "the end", EN, owner)).toBe(true),
    );
    expect(calls).toBe(0);
  });

  test("a match at the very end is still found in both locales", () => {
    expect(titleMatches(`${BIG}retry budget`, "RETRY BUDGET", EN, {})).toBe(true);
    expect(titleMatches(`${BIG}son`, "IŞIK. SON", TR, {})).toBe(true);
  });
});
