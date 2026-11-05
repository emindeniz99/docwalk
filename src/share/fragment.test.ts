import { fc, test as fcTest } from "@fast-check/vitest";
import { describe, expect, test } from "vitest";
import { MAX_DOCUMENT_BYTES } from "../inputs/types";
import { decodeDoc, encodeDoc, isDocHash, readFragment } from "./fragment";
import { FRAGMENT_MAX_CHARS } from "./types";

/** deflate-raw + base64url of arbitrary bytes, to forge fragments the encoder would never write. */
async function forge(bytes: Uint8Array): Promise<string> {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate-raw"));
  const compressed = new Uint8Array(await new Response(stream).arrayBuffer());
  return Buffer.from(compressed).toString("base64url");
}

describe("share fragment round trip", () => {
  // `unit: "binary"` covers every code point, astral planes included. Lone
  // surrogates are left out: TextEncoder turns them into U+FFFD, and no
  // editor or file produces them.
  fcTest.prop([fc.string({ unit: "binary", maxLength: 2_000 })])(
    "any Unicode document comes back unchanged, so a shared link shows exactly what was written",
    async (markdown) => {
      expect(await decodeDoc(await encodeDoc(markdown))).toBe(markdown);
    },
  );

  test("emoji, combining marks and right-to-left text survive the trip", async () => {
    const markdown =
      "# Plan 🚀👩🏽‍💻\n\nCafé · שלום · 日本語 · 🏳️‍🌈\n\n```mermaid\ngraph TD; A-->B\n```\n";
    expect(await decodeDoc(await encodeDoc(markdown))).toBe(markdown);
  });

  test("a leading byte-order mark survives, so a file saved by a Windows editor comes back byte for byte", async () => {
    // TextDecoder drops a leading U+FEFF by default; the round-trip property
    // above would then fail on the rare seed that starts with one.
    const markdown = "﻿# Notes\n";
    expect(await decodeDoc(await encodeDoc(markdown))).toBe(markdown);
  });

  test("a long document round-trips, and repetitive Markdown compresses well below its size", async () => {
    const section = "## Section\n\nSome text with a [link](https://example.com) and `code`.\n\n";
    const markdown = section.repeat(10_000); // ~700 KB
    const encoded = await encodeDoc(markdown);
    expect(encoded.length).toBeLessThan(markdown.length / 50);
    expect(await decodeDoc(encoded)).toBe(markdown);
  });

  test("the encoding uses only URL-safe characters, so no app percent-encodes or cuts it", async () => {
    const encoded = await encodeDoc("?&#=/+ ünïcödé ".repeat(200));
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe("hostile fragments are refused, never thrown", () => {
  test.each([
    ["empty", ""],
    ["characters outside base64url", "abc$def"],
    ["standard base64 padding", "AAAA=="],
    ["a length no byte sequence encodes to", "AAAAA"],
    ["valid base64url that is not deflate data", "____"],
  ])("%s", async (_, value) => {
    expect(await decodeDoc(value)).toBeNull();
  });

  test("a fragment longer than any link docwalk writes is rejected before decoding", async () => {
    expect(await decodeDoc("A".repeat(FRAGMENT_MAX_CHARS + 1))).toBeNull();
  });

  test("a truncated link (an app cut it short) is rejected instead of showing half a document", async () => {
    const encoded = await encodeDoc("# Title\n\n" + "Lorem ipsum dolor sit amet. ".repeat(500));
    expect(await decodeDoc(encoded.slice(0, Math.floor(encoded.length / 2)))).toBeNull();
  });

  test("bytes that are not UTF-8 are rejected rather than shown as replacement characters", async () => {
    expect(await decodeDoc(await forge(new Uint8Array([0x23, 0x20, 0xff, 0xfe])))).toBeNull();
  });

  test("a decompression bomb stops at the document cap, so a tiny link cannot exhaust memory", async () => {
    const bomb = await forge(new Uint8Array(MAX_DOCUMENT_BYTES + 1).fill(0x61));
    // The bomb is a few KB: it passes every length check, only the output cap stops it.
    expect(bomb.length).toBeLessThan(FRAGMENT_MAX_CHARS);
    expect(await decodeDoc(bomb)).toBeNull();
  });

  test("a document exactly at the cap still opens, so the cap is the limit and not lower", async () => {
    const atCap = await forge(new Uint8Array(MAX_DOCUMENT_BYTES).fill(0x61));
    expect(await decodeDoc(atCap)).toHaveLength(MAX_DOCUMENT_BYTES);
  });

  fcTest.prop([fc.string({ maxLength: 400 })])(
    "arbitrary text never throws, so a hand-edited link cannot crash the app",
    async (value) => {
      const result = await decodeDoc(value);
      expect(result === null || typeof result === "string").toBe(true);
    },
  );

  fcTest.prop([fc.uint8Array({ maxLength: 400 })])(
    "arbitrary bytes in a well-formed fragment never throw",
    async (bytes) => {
      const result = await decodeDoc(Buffer.from(bytes).toString("base64url") || "A");
      expect(result === null || typeof result === "string").toBe(true);
    },
  );
});

describe("readFragment", () => {
  test("reads the document from a #doc= hash", async () => {
    expect(await readFragment(`#doc=${await encodeDoc("# Shared")}`)).toBe("# Shared");
  });

  test.each(["", "#", "#failure-handling/2", "#documentation"])(
    "leaves %j alone, because slide addresses belong to the URL module",
    async (hash) => {
      expect(isDocHash(hash)).toBe(false);
      expect(await readFragment(hash)).toBeNull();
    },
  );

  test("a damaged #doc= hash reads as null but is still recognised, so the app can say the link is broken", async () => {
    expect(isDocHash("#doc=$$$")).toBe(true);
    expect(await readFragment("#doc=$$$")).toBeNull();
  });
});
