import { describe, expect, test } from "vitest";
import { pickLocale } from "./pick";

describe("pickLocale: which language a visit opens in (decision 56)", () => {
  test("the viewer's stored choice wins over the browser's languages", () => {
    // Someone who picked English on a Turkish system must keep English.
    expect(pickLocale("en", ["tr-TR", "tr"])).toBe("en");
    expect(pickLocale("tr", ["en-US"])).toBe("tr");
  });

  test("without a choice, the first browser language docwalk has decides", () => {
    expect(pickLocale(null, ["tr-TR", "en-US"])).toBe("tr");
    expect(pickLocale(null, ["de-DE", "tr", "en"])).toBe("tr");
    expect(pickLocale(null, ["en-GB", "tr-TR"])).toBe("en");
    // Language tags are case-insensitive (BCP 47).
    expect(pickLocale(null, ["TR-tr"])).toBe("tr");
  });

  test("a stored value that names no locale, or no match at all, falls back to English", () => {
    // Storage is per-browser and can hold anything (an old build, a hand edit).
    expect(pickLocale("klingon", ["tr-TR"])).toBe("tr");
    expect(pickLocale(null, ["de-DE", "fr"])).toBe("en");
    expect(pickLocale(null, [])).toBe("en");
  });
});
