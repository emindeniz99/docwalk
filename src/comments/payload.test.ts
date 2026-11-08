import { describe, expect, test } from "vitest";
import { buildShareLink } from "../share/link";
import { readFragment } from "../share/fragment";
import { FRAGMENT_MAX_CHARS } from "../share/types";
import {
  commentsParam,
  DAMAGED_COMMENTS,
  decodeComments,
  encodeComments,
  hashWithoutComments,
} from "./payload";
import type { DocComment } from "./types";

/**
 * Comments travel inside the share link (decision 55). Links people already
 * sent carry no comments and must keep opening; a link with comments must
 * hand the recipient exactly what the sender had; and a hand-edited link is
 * hostile input like any other.
 */

const base = "https://docwalk.example/";
const markdown = "# Plan\n\n## Goals\n\nShip it.\n";
const comments: DocComment[] = [
  {
    id: "c1",
    anchor: { kind: "heading", slug: "goals" },
    text: "Which quarter?\nAnd who owns it?",
    created: 1,
    updated: 1,
    resolved: false,
  },
  {
    id: "c2",
    anchor: { kind: "node", heading: "goals", diagram: 0, node: "api_gw" },
    text: "<b>not bold</b>",
    created: 2,
    updated: 3,
    resolved: true,
  },
];

describe("share round trip", () => {
  test("a pasted document's link carries the document and its comments", async () => {
    const result = await buildShareLink({
      source: { kind: "paste" },
      markdown,
      base,
      comments: await encodeComments(comments),
    });
    if (!result.ok) throw new Error(result.message);
    const hash = new URL(result.link.url).hash;
    expect(hash).toMatch(/^#doc=[\w-]+&c=[\w-]+$/);
    expect(await readFragment(hash)).toBe(markdown);
    expect(await decodeComments(commentsParam(hash)!)).toEqual({
      ok: true,
      comments,
      deleted: [],
    });
  });

  test("a ?src= link carries comments in a #c= fragment, which no server receives", async () => {
    const result = await buildShareLink({
      source: {
        kind: "url",
        url: "https://raw.githubusercontent.com/o/r/main/a.md",
        trusted: true,
      },
      markdown,
      base,
      comments: await encodeComments(comments),
    });
    if (!result.ok) throw new Error(result.message);
    const url = new URL(result.link.url);
    expect(url.searchParams.get("src")).toBe("https://raw.githubusercontent.com/o/r/main/a.md");
    expect(url.hash).toMatch(/^#c=[\w-]+$/);
    expect(await decodeComments(commentsParam(url.hash)!)).toEqual({
      ok: true,
      comments,
      deleted: [],
    });
  });

  test("a link carries the deletions too, so an old link cannot bring a deleted comment back", async () => {
    const deleted = [{ id: "c9", deleted: 99 }];
    const hash = `#c=${await encodeComments(comments, deleted)}`;
    expect(await decodeComments(commentsParam(hash)!)).toEqual({ ok: true, comments, deleted });
  });

  test("a link written before deletions were carried still reads, with none", async () => {
    // Compact JSON exactly as an earlier build wrote it: no `deleted` key.
    const { encodeDoc } = await import("../share/fragment");
    const old = await encodeDoc(
      JSON.stringify({ format: "docwalk-comments", version: 1, comments }),
    );
    expect(await decodeComments(old)).toEqual({ ok: true, comments, deleted: [] });
  });

  test("an old link without comments opens exactly as before", async () => {
    const result = await buildShareLink({ source: { kind: "paste" }, markdown, base });
    if (!result.ok) throw new Error(result.message);
    const hash = new URL(result.link.url).hash;
    expect(commentsParam(hash)).toBeNull();
    expect(await readFragment(hash)).toBe(markdown);
    expect(result.link.commentsDropped).toBe(false);
  });

  test("comments that would push the link past the cap are left out and flagged, the document still shares", async () => {
    // Incompressible text, so the comments payload alone is near the cap.
    let seed = 1;
    const noise = () =>
      Array.from({ length: 3900 }, () => {
        seed = (seed * 48271) % 2147483647;
        return String.fromCharCode(0x4e00 + (seed % 0x5000));
      }).join("");
    const big = Array.from({ length: 12 }, (_, i) => ({
      ...comments[0]!,
      id: `big${i}`,
      text: noise(),
    }));
    const encoded = await encodeComments(big);
    expect(encoded.length).toBeGreaterThan(FRAGMENT_MAX_CHARS);
    const result = await buildShareLink({
      source: { kind: "paste" },
      markdown,
      base,
      comments: encoded,
    });
    if (!result.ok) throw new Error(result.message);
    expect(result.link.commentsDropped).toBe(true);
    expect(commentsParam(new URL(result.link.url).hash)).toBeNull();
    expect(await readFragment(new URL(result.link.url).hash)).toBe(markdown);
  });
});

describe("hostile link values", () => {
  test.each([
    ["not base64url", "!!!"],
    ["base64 of garbage", "AAAA"],
    ["empty", ""],
  ])("%s is refused as damaged", async (_name, value) => {
    expect(await decodeComments(value)).toEqual({ ok: false, message: DAMAGED_COMMENTS() });
  });

  test("a valid deflate payload that is not a comments file is refused", async () => {
    const { encodeDoc } = await import("../share/fragment");
    expect(await decodeComments(await encodeDoc('{"format":"other"}'))).toEqual({
      ok: false,
      message: DAMAGED_COMMENTS(),
    });
  });
});

describe("hash handling", () => {
  test("removing the comments keeps the document and drops a bare #c=", () => {
    expect(hashWithoutComments("#doc=abc&c=def")).toBe("#doc=abc");
    expect(hashWithoutComments("#c=def")).toBe("");
    expect(hashWithoutComments("#doc=abc")).toBe("#doc=abc");
  });
});
