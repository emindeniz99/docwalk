import { fc, test as fcTest } from "@fast-check/vitest";
import GithubSlugger from "github-slugger";
import { describe, expect, test } from "vitest";
import { fallbackHeadingId, type HeadingDepth } from "../sectioning/sectionize";
import { formatViewerUrl, parseViewerUrl, sectionsFitInLink, withoutDocumentLink } from "./state";
import type { ViewerUrlState } from "./types";

const BASE = "https://docwalk.example/";
const parse = (href: string) => parseViewerUrl(new URL(href, BASE));
const address = (hash: string) => parse(hash).address;

describe("parseViewerUrl: the slide address in the hash", () => {
  test("a section and page open that page, so a shared link lands on the slide it names", () => {
    expect(address("#failure-handling/2")).toBe("failure-handling/2");
  });

  test("a bare GitHub heading anchor opens the section's first page, so README links work as deck links", () => {
    expect(address("#failure-handling")).toBe("failure-handling/1");
  });

  test("no hash means no address, so the deck starts on its first slide", () => {
    expect(address("/")).toBeNull();
    expect(address("#")).toBeNull();
  });

  test("percent-encoded non-Latin anchors decode, because GitHub slugs keep letters of every script", () => {
    // The browser encodes the fragment; the slug itself is "café-planı".
    expect(address("#caf%C3%A9-plan%C4%B1/3")).toBe("café-planı/3");
    expect(address("#日本語")).toBe("日本語/1");
  });

  test("an encoded slash stays inside the id and fails, so it cannot forge a page number", () => {
    expect(address("#intro%2F2")).toBeNull();
    expect(address("#intro%2f2/1")).toBeNull();
  });

  test("anything that is not a plausible slug or page is ignored instead of throwing", () => {
    const accepted = [
      "#<script>alert(1)</script>",
      "#%3Cscript%3E",
      "#javascript:alert(1)",
      "#intro/0",
      "#intro/01",
      "#intro/-1",
      "#intro/2.5",
      "#intro/999999",
      "#intro/2/3",
      "#intro/",
      "#/2",
      "#%E0%A4%A", // malformed percent-encoding: decodeURIComponent would throw
      "#intro section",
      "#a.b",
    ].filter((hash) => address(hash) !== null);
    expect(accepted).toEqual([]);
  });

  test("a very long hash is skipped without decoding, so a hostile link costs nothing", () => {
    expect(address(`#${"a".repeat(100_000)}`)).toBeNull();
    expect(address(`#${"a".repeat(201)}`)).toBeNull();
    expect(address(`#${"%41".repeat(1000)}`)).toBeNull();
  });

  test("a #doc= share fragment is not a slide address, so the share loader can own it", () => {
    expect(address("#doc=eJzLSM3JyQcABiwCFQ")).toBeNull();
  });

  test("a long non-Latin heading still links, because the browser encodes each character as up to 12", () => {
    // 200 CJK characters encode to 1,800 characters of hash; the length cap
    // must not drop a link that format wrote.
    const id = "日".repeat(200);
    const written = formatViewerUrl(new URL(BASE), { address: `${id}/2` });
    expect(written.hash.length).toBeGreaterThan(1800);
    expect(parseViewerUrl(written).address).toBe(`${id}/2`);
  });
});

describe("every section id the sectioner produces is linkable", () => {
  // src/sectioning slugs headings with github-slugger. If the id rule here
  // were narrower, those slides would silently lose their links.
  fcTest.prop([fc.string({ unit: "grapheme", minLength: 1, maxLength: 60 })])(
    "a slugged heading round-trips through the hash",
    (heading) => {
      // An empty slug (emoji-only heading) gets the sectioner's fallback.
      const id = new GithubSlugger().slug(heading) || fallbackHeadingId(heading);
      // Ids over the 200 cap are out of scope.
      fc.pre([...id].length <= 200);
      const written = formatViewerUrl(new URL(BASE), { address: `${id}/3` });
      expect(parseViewerUrl(written).address).toBe(`${id}/3`);
    },
  );

  test("connector punctuation and circled letters, which github-slugger keeps, are accepted", () => {
    const rejected = ["a‿b", "ⓐ plan", "snake_case", "fullwidth＿low"].filter((heading) => {
      const id = new GithubSlugger().slug(heading);
      return address(`#${encodeURIComponent(id)}/2`) !== `${id}/2`;
    });
    expect(rejected).toEqual([]);
  });
});

describe("parseViewerUrl: viewer settings in the query", () => {
  test("level takes auto, one level, or a list, so the override in the UI survives a reload", () => {
    expect(parse("?level=auto").level).toBe("auto");
    expect(parse("?level=3").level).toBe(3);
    expect(parse("?level=1,3").level).toEqual([1, 3]);
  });

  test("a level list is sorted and deduplicated, so hand-edited lists mean the same thing", () => {
    expect(parse("?level=3,1,3,2").level).toEqual([1, 2, 3]);
    // One level left after deduplication is that level, not a one-item list.
    expect(parse("?level=2,2").level).toBe(2);
  });

  test("an invalid level is null, so a typo falls back to the default instead of crashing", () => {
    const accepted = [
      "0",
      "7",
      "1,7",
      "",
      ",",
      "1,,2",
      " 2",
      "02",
      "two",
      "1;2",
      "AUTO",
      "2".repeat(40),
    ].filter((raw) => parse(`?level=${encodeURIComponent(raw)}`).level !== null);
    expect(accepted).toEqual([]);
    expect(parse("/").level).toBeNull();
  });

  test("view takes the four known views and nothing else", () => {
    for (const view of ["edit", "document", "present", "presenter"] as const) {
      expect(parse(`?view=${view}`).view).toBe(view);
    }
    const accepted = ["Present", "slides", "", "present%00", "<img src=x>"].filter(
      (raw) => parse(`?view=${raw}`).view !== null,
    );
    expect(accepted).toEqual([]);
  });

  test("the first of repeated parameters wins, matching URLSearchParams.get", () => {
    expect(parse("?view=document&view=present").view).toBe("document");
  });
});

const format = (href: string, state: Partial<ViewerUrlState>) =>
  formatViewerUrl(new URL(href, BASE), state);

describe("formatViewerUrl", () => {
  test("unrelated query parameters keep their exact spelling, so ?src= links still load", () => {
    const url = format("/?src=https://raw.githubusercontent.com/o/r/main/a%20b.md&flag&view=edit", {
      view: "present",
      level: [1, 3],
    });
    expect(url.search).toBe(
      "?src=https://raw.githubusercontent.com/o/r/main/a%20b.md&flag&view=present&level=1%2C3",
    );
  });

  test("null removes a setting, so returning to the default cleans the link", () => {
    expect(format("/?view=edit&src=x&level=2", { view: null, level: null }).search).toBe("?src=x");
    expect(format("/?view=edit", { view: null }).href).toBe(BASE);
  });

  test("fields that are left out are left alone", () => {
    const url = format("/?level=2&view=document#intro/2", { view: "present" });
    expect(url.search).toBe("?level=2&view=present");
    expect(url.hash).toBe("#intro/2");
  });

  test("an invalid value removes the setting instead of writing what parse would reject", () => {
    const bad = { level: 9 as HeadingDepth, view: "slides" as ViewerUrlState["view"] };
    expect(format("/?level=2&view=edit", bad).search).toBe("");
    expect(format("/#intro/2", { address: "not a slug/2" }).hash).toBe("");
  });

  test("the address goes into the hash, encoded, and a null address clears it", () => {
    expect(format("/", { address: "failure-handling/2" }).hash).toBe("#failure-handling/2");
    expect(format("/", { address: "café/1" }).hash).toBe("#caf%C3%A9/1");
    expect(format("/#intro/2", { address: null }).href).toBe(BASE);
  });

  test("a #doc= share fragment is never overwritten, so slide changes cannot destroy a shared document", () => {
    const shared = "/?view=present#doc=eJzLSM3JyQcABiwCFQ";
    expect(format(shared, { address: "intro/2" }).hash).toBe("#doc=eJzLSM3JyQcABiwCFQ");
    expect(format(shared, { address: null }).hash).toBe("#doc=eJzLSM3JyQcABiwCFQ");
  });

  test("the base URL is not mutated, so callers can keep comparing against it", () => {
    const base = new URL("/?view=edit#a/1", BASE);
    formatViewerUrl(base, { view: "present", address: "b/2" });
    expect(base.href).toBe(`${BASE}?view=edit#a/1`);
  });
});

describe("format then parse round-trips every valid state", () => {
  // Includes 4-byte characters (𝒜 encodes to 12) and ids up to the 200 cap.
  const slugChar = fc.constantFrom(...Array.from("abcxyz019-_éıß日本‿ⓐ𝒜"));
  const sectionId = fc.string({ unit: slugChar, minLength: 1, maxLength: 200 });
  // Short enough that five of them stay under the encoded-length limit even at 12 characters each.
  const shortId = fc.string({ unit: slugChar, minLength: 1, maxLength: 20 });
  const page = fc.integer({ min: 1, max: 99_999 });
  const depth = fc.constantFrom<HeadingDepth>(1, 2, 3, 4, 5, 6);
  const state = fc.record({
    address: fc.option(fc.tuple(sectionId, page).map(([id, n]) => `${id}/${n}`)),
    level: fc.option(
      fc.oneof(
        fc.constant("auto" as const),
        depth,
        fc
          .uniqueArray(depth, { minLength: 2, maxLength: 6 })
          .map((list) => list.toSorted((a, b) => a - b)),
      ),
    ),
    view: fc.option(fc.constantFrom("edit", "document", "present", "presenter" as const)),
    sections: fc.option(fc.uniqueArray(shortId, { minLength: 1, maxLength: 5 })),
  }) as fc.Arbitrary<ViewerUrlState>;
  const unrelated = fc.constantFrom(
    "",
    "?src=https://raw.githubusercontent.com/o/r/HEAD/x.md",
    "?a=1&b",
  );

  fcTest.prop([state, unrelated])(
    "a link the app writes is read back as the same state, so reloading never moves the viewer",
    (s, query) => {
      const url = formatViewerUrl(new URL(`/${query}`, BASE), s);
      expect(parseViewerUrl(url)).toEqual(s);
      // ...and the unrelated parameters are still there.
      for (const [key, value] of new URL(`/${query}`, BASE).searchParams) {
        expect(url.searchParams.get(key)).toBe(value);
      }
    },
  );

  fcTest.prop([fc.string({ maxLength: 300 }), fc.string({ maxLength: 300 })])(
    "arbitrary hashes and queries never throw, so no hand-edited link can crash the app",
    (hash, query) => {
      const url = new URL(BASE);
      url.hash = hash;
      url.search = query;
      const s = parseViewerUrl(url);
      // Whatever parse accepts, format must be able to write back unchanged.
      expect(parseViewerUrl(formatViewerUrl(new URL(BASE), s))).toEqual(s);
    },
  );
});

const sections = (search: string) => parse(`?sections=${search}`).sections;
const ids = (count: number) => Array.from({ length: count }, (_, i) => `s${i}`);
// Distinct ids of 200 ASCII letters each.
const wide = (count: number) =>
  Array.from({ length: count }, (_, i) => String.fromCharCode(97 + i).repeat(200));

describe("the section selection in the query (?sections=)", () => {
  test("a list of section ids is read in the order written, so the link names what to present", () => {
    expect(sections("summary,rollout")).toEqual(["summary", "rollout"]);
    expect(sections("rollout")).toEqual(["rollout"]);
  });

  test("encoded commas split the same way, because the app writes them as %2C", () => {
    expect(sections("summary%2Crollout")).toEqual(["summary", "rollout"]);
  });

  test("no parameter, or an empty one, means every section (null), so plain links are unchanged", () => {
    expect(parse("/").sections).toBeNull();
    expect(sections("")).toBeNull();
    expect(parse("?level=2&view=edit#intro/2").sections).toBeNull();
  });

  test("a repeated id counts once, at its first place, so a hand-edited list means one thing", () => {
    expect(sections("b,a,b,a")).toEqual(["b", "a"]);
  });

  test("ids in any script decode, because GitHub anchors keep letters of every script", () => {
    // Turkish dotless i, CJK, and a 4-byte letter (mathematical script A).
    expect(sections("caf%C3%A9-plan%C4%B1,%E6%97%A5%E6%9C%AC%E8%AA%9E,%F0%9D%92%9C")).toEqual([
      "café-planı",
      "日本語",
      "𝒜",
    ]);
    expect(sections(encodeURIComponent("İstanbul-ışık"))).toEqual(["İstanbul-ışık"]);
  });

  test("one malformed item makes the whole parameter null, so a typo shows every section instead of a guess", () => {
    const accepted = [
      "a,,b",
      "a,",
      ",a",
      ",",
      "a b",
      "a+b",
      "a/b",
      "a%2Fb",
      "a.b",
      "a=b",
      "<script>alert(1)</script>",
      "javascript:alert(1)",
      "%E0%A4%A", // malformed percent-encoding
      "%00",
      "%ED%A0%80", // a lone surrogate, which is not valid UTF-8
      "a".repeat(201),
      `ok,${"a".repeat(201)}`,
    ].filter((raw) => sections(raw) !== null);
    expect(accepted).toEqual([]);
  });

  test("the longest valid id passes and one more code point fails, matching the slide address", () => {
    expect(sections("日".repeat(200).replaceAll("日", "%E6%97%A5"))).toEqual(["日".repeat(200)]);
    expect(sections("日".repeat(201).replaceAll("日", "%E6%97%A5"))).toBeNull();
  });

  test("at most 100 ids, so a link cannot ask for an unbounded list", () => {
    expect(sections(ids(100).join(","))).toEqual(ids(100));
    expect(sections(ids(101).join(","))).toBeNull();
  });

  test("the encoded value is capped at 4000 characters, and a hostile one is rejected without decoding", () => {
    // 19 ids of 200 letters and 18 commas: 3818 characters.
    expect(sections(wide(19).join(","))).toEqual(wide(19));
    // 21 ids: 4220 characters.
    expect(sections(wide(21).join(","))).toBeNull();
    expect(sections("%41".repeat(2000))).toBeNull();
    expect(sections("a".repeat(1_000_000))).toBeNull();
  });

  test("sections sits beside ?src=, level and a slide address without disturbing them", () => {
    const state = parse(
      "?src=https://raw.githubusercontent.com/o/r/main/a.md&sections=a,b&level=2#a/3",
    );
    expect(state).toMatchObject({ sections: ["a", "b"], level: 2, address: "a/3" });
  });

  test("a #doc= share fragment keeps its meaning beside a selection", () => {
    const state = parse("?sections=a,b#doc=eJzLSM3JyQcABiwCFQ");
    expect(state.sections).toEqual(["a", "b"]);
    expect(state.address).toBeNull();
  });
});

describe("formatViewerUrl: the section selection", () => {
  test("a selection is written as one comma-joined value, so the link stays short", () => {
    expect(format("/", { sections: ["summary", "rollout"] }).search).toBe(
      "?sections=summary%2Crollout",
    );
  });

  test("other parameters keep their exact spelling, so ?src= links still load", () => {
    const url = format("/?src=https://raw.githubusercontent.com/o/r/main/a%20b.md&level=2", {
      sections: ["a", "b"],
    });
    expect(url.search).toBe(
      "?src=https://raw.githubusercontent.com/o/r/main/a%20b.md&level=2&sections=a%2Cb",
    );
  });

  test("ids in other scripts are percent-encoded and read back unchanged", () => {
    const scriptIds = ["café-planı", "日本語", "𝒜", "İstanbul"];
    const written = format("/", { sections: scriptIds });
    expect(written.search).toBe(
      "?sections=caf%C3%A9-plan%C4%B1%2C%E6%97%A5%E6%9C%AC%E8%AA%9E%2C%F0%9D%92%9C%2C%C4%B0stanbul",
    );
    expect(parseViewerUrl(written).sections).toEqual(scriptIds);
  });

  test("null or an empty list removes the parameter, so every section is the plain link", () => {
    expect(format("/?sections=a,b&level=2", { sections: null }).search).toBe("?level=2");
    expect(format("/?sections=a,b", { sections: [] }).href).toBe(BASE);
  });

  test("a field that is left out is left alone", () => {
    expect(format("/?sections=a,b", { view: "present" }).search).toBe("?sections=a,b&view=present");
  });

  test("an invalid id removes the parameter instead of writing what parse would reject", () => {
    expect(format("/?sections=a", { sections: ["ok", "not a slug"] }).search).toBe("");
    expect(format("/", { sections: ["a/b"] }).search).toBe("");
    expect(format("/", { sections: ["a".repeat(201)] }).search).toBe("");
  });

  test("a selection over the limits is not written and an old one is removed, so a link never lies", () => {
    const many = Array.from({ length: 101 }, (_, i) => `s${i}`);
    expect(format("/", { sections: many }).search).toBe("");
    expect(format("/?sections=a", { sections: many }).search).toBe("");
    expect(format("/", { sections: wide(21) }).search).toBe("");
  });

  test("repeats are written once, so the link says what parse will read", () => {
    expect(format("/", { sections: ["a", "b", "a"] }).search).toBe("?sections=a%2Cb");
  });

  test("the hash, including a #doc= fragment, is untouched", () => {
    const shared = "/?view=present#doc=eJzLSM3JyQcABiwCFQ";
    expect(format(shared, { sections: ["a"] }).hash).toBe("#doc=eJzLSM3JyQcABiwCFQ");
    expect(format("/#intro/2", { sections: ["a"] }).hash).toBe("#intro/2");
  });
});

describe("sectionsFitInLink", () => {
  test("is true for what format writes and false for what it drops, so the picker can warn", () => {
    expect(sectionsFitInLink(["summary", "rollout"])).toBe(true);
    expect(sectionsFitInLink(Array.from({ length: 100 }, (_, i) => `s${i}`))).toBe(true);
    expect(sectionsFitInLink(Array.from({ length: 101 }, (_, i) => `s${i}`))).toBe(false);
    expect(sectionsFitInLink(["a".repeat(201)])).toBe(false);
    expect(sectionsFitInLink(wide(21))).toBe(false);
  });
});

describe("withoutDocumentLink", () => {
  test("drops what names a document and keeps the viewer's settings and slide address", () => {
    // A reload of a page whose link was replaced by a workspace file must reopen
    // that file (decision 66), in the level and view the viewer chose.
    const src = "https%3A%2F%2Fraw.githubusercontent.com%2Fa%2Fb%2Fmain%2Fc.md";
    expect(
      withoutDocumentLink(new URL(`https://d.test/?level=2&src=${src}&view=edit#intro/2`)).href,
    ).toBe("https://d.test/?level=2&view=edit#intro/2");
    expect(
      withoutDocumentLink(new URL("https://d.test/?repo=o/r&path=a.md&ref=main#doc=abc&c=x")).href,
    ).toBe("https://d.test/");
    expect(withoutDocumentLink(new URL("https://d.test/?level=3#c=abc")).href).toBe(
      "https://d.test/?level=3",
    );
  });
});
