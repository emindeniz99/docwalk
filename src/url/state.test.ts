import { fc, test as fcTest } from "@fast-check/vitest";
import GithubSlugger from "github-slugger";
import { describe, expect, test } from "vitest";
import type { HeadingDepth } from "../sectioning/sectionize";
import { formatViewerUrl, parseViewerUrl } from "./state";
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
      const id = new GithubSlugger().slug(heading);
      // Empty slugs (emoji-only headings) and ids over the 200 cap are out of scope.
      fc.pre(id !== "" && [...id].length <= 200);
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
