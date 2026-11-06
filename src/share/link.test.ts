import { describe, expect, test } from "vitest";
import type { DocumentSource } from "../inputs/types";
import { DOC_HASH_PREFIX, encodeDoc, readFragment } from "./fragment";
import {
  buildShareLink,
  LONG_LINK_WARNING,
  TOKEN_REMOVED_WARNING,
  TOO_LONG_MESSAGE,
  type ShareLinkResult,
} from "./link";
import { FRAGMENT_MAX_CHARS, FRAGMENT_WARN_CHARS } from "./types";

const BASE = "https://docwalk.example/app/";
const TOKEN = "ghp_exampleExampleExample0123456789";

function link(result: ShareLinkResult) {
  if (!result.ok) throw new Error(`expected a link, got: ${result.message}`);
  return result.link;
}

/** Random-looking text that deflate cannot shrink much, to reach the length thresholds. */
function incompressible(chars: number): string {
  // mulberry32: deterministic, and without the short period of a plain LCG.
  let seed = 7;
  let out = "";
  while (out.length < chars) {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    out += String.fromCharCode(0x21 + (((t ^ (t >>> 14)) >>> 0) % 94));
  }
  return out;
}

describe("documents that can be reloaded share as their source link", () => {
  test("a ?src= document shares as ?src=, so the recipient sees the current file", async () => {
    const source: DocumentSource = {
      kind: "url",
      url: "https://raw.githubusercontent.com/acme/docs/main/design.md",
      trusted: true,
    };
    const result = link(await buildShareLink({ source, markdown: "# ignored", base: BASE }));
    expect(result.kind).toBe("source");
    expect(result.warning).toBeNull();
    const url = new URL(result.url);
    expect(url.origin + url.pathname).toBe(BASE);
    expect(url.searchParams.get("src")).toBe(source.url);
    expect(url.hash).toBe("");
  });

  test("a repo document shares as ?repo=&path=&ref=", async () => {
    const source: DocumentSource = {
      kind: "repo",
      repo: "acme/docs",
      path: "docs/design doc.md",
      ref: "release/2.0",
    };
    const url = new URL(link(await buildShareLink({ source, markdown: "", base: BASE })).url);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      repo: "acme/docs",
      path: "docs/design doc.md",
      ref: "release/2.0",
    });
  });

  test("a repo document without a ref leaves ref out, so the default branch is used", async () => {
    const source: DocumentSource = {
      kind: "repo",
      repo: "acme/docs",
      path: "README.md",
      ref: null,
    };
    const url = new URL(link(await buildShareLink({ source, markdown: "", base: BASE })).url);
    expect(url.searchParams.has("ref")).toBe(false);
  });
});

describe("other documents share as a #doc= fragment", () => {
  test.each<DocumentSource>([
    { kind: "paste" },
    { kind: "file", name: "notes.md" },
    { kind: "sample" },
    { kind: "fragment" },
  ])("$kind: the link carries the text, which decodes back to it", async (source) => {
    const markdown = "# Pasted 🧭\n\nOnly in this browser.";
    const result = link(await buildShareLink({ source, markdown, base: BASE }));
    expect(result.kind).toBe("fragment");
    expect(result.url.startsWith(`${BASE}${DOC_HASH_PREFIX}`)).toBe(true);
    expect(await readFragment(new URL(result.url).hash)).toBe(markdown);
  });

  test("a short fragment link has no warning", async () => {
    const result = link(
      await buildShareLink({ source: { kind: "paste" }, markdown: "# Hi", base: BASE }),
    );
    expect(result.warning).toBeNull();
  });

  test("above the warning length the link still builds, with a plain-English warning", async () => {
    const result = link(
      await buildShareLink({
        source: { kind: "paste" },
        markdown: incompressible(FRAGMENT_WARN_CHARS),
        base: BASE,
      }),
    );
    expect(result.url.length).toBeGreaterThan(FRAGMENT_WARN_CHARS);
    expect(result.url.length).toBeLessThanOrEqual(FRAGMENT_MAX_CHARS);
    expect(result.warning).toBe(LONG_LINK_WARNING());
  });

  test("above the maximum, no link is built and the message suggests what to do instead", async () => {
    const result = await buildShareLink({
      source: { kind: "paste" },
      markdown: incompressible(FRAGMENT_MAX_CHARS),
      base: BASE,
    });
    expect(result).toEqual({ ok: false, message: TOO_LONG_MESSAGE() });
  });
});

describe("tokens never reach a link", () => {
  // The page's own URL can carry anything: an OAuth callback's ?code=, a
  // hand-pasted ?token=, a stale hash. The link starts from origin + path.
  const dirtyBase = `https://user:${TOKEN}@docwalk.example/app/?token=${TOKEN}&code=abc&src=x#doc=old`;

  test.each<DocumentSource>([
    { kind: "paste" },
    { kind: "url", url: "https://raw.githubusercontent.com/a/b/main/c.md", trusted: true },
    { kind: "repo", repo: "a/b", path: "c.md", ref: null },
  ])("$kind: nothing from the page's query, hash or user info is copied", async (source) => {
    const result = link(await buildShareLink({ source, markdown: "# Doc", base: dirtyBase }));
    expect(result.url).not.toContain(TOKEN);
    expect(result.url).not.toContain("code=");
    expect(new URL(result.url).username).toBe("");
    expect(result.url).not.toContain("old");
  });

  test("a private raw.githubusercontent.com link loses its ?token= and says the link may not open", async () => {
    const source: DocumentSource = {
      kind: "url",
      url: `https://raw.githubusercontent.com/acme/private/main/plan.md?token=${TOKEN}`,
      trusted: true,
    };
    const result = link(await buildShareLink({ source, markdown: "", base: BASE }));
    expect(result.url).not.toContain(TOKEN);
    expect(new URL(result.url).searchParams.get("src")).toBe(
      "https://raw.githubusercontent.com/acme/private/main/plan.md",
    );
    expect(result.warning).toBe(TOKEN_REMOVED_WARNING());
  });

  test("credentials in a ?src= URL's user info are removed", async () => {
    const source: DocumentSource = {
      kind: "url",
      url: `https://bot:${TOKEN}@docs.example.org/a.md?access_token=${TOKEN}&v=2`,
      trusted: false,
    };
    const result = link(await buildShareLink({ source, markdown: "", base: BASE }));
    expect(result.url).not.toContain(TOKEN);
    expect(new URL(result.url).searchParams.get("src")).toBe("https://docs.example.org/a.md?v=2");
  });

  test("a ?src= URL's hash is dropped, so an implicit-flow #access_token= cannot ride along", async () => {
    // fetch never sends the hash, so dropping it changes nothing the recipient loads.
    const source: DocumentSource = {
      kind: "url",
      url: `https://docs.example.org/a.md#access_token=${TOKEN}`,
      trusted: false,
    };
    const result = link(await buildShareLink({ source, markdown: "", base: BASE }));
    expect(result.url).not.toContain(TOKEN);
    expect(new URL(result.url).searchParams.get("src")).toBe("https://docs.example.org/a.md");
  });

  test.each(["password", "X-Amz-Credential", "session_id", "jwt", "pwd"])(
    "a ?src= parameter named %s is treated as an access secret and removed",
    async (name) => {
      const source: DocumentSource = {
        kind: "url",
        url: `https://docs.example.org/a.md?${name}=${TOKEN}`,
        trusted: false,
      };
      const result = link(await buildShareLink({ source, markdown: "", base: BASE }));
      expect(result.url).not.toContain(TOKEN);
      expect(result.warning).toBe(TOKEN_REMOVED_WARNING());
    },
  );

  test("an app opened from a file:// page still builds a link, because its origin is opaque", async () => {
    // `new URL(origin + pathname)` throws for the opaque origin "null"; the
    // dialog would then say no link can be built in a static, offline copy.
    const result = link(
      await buildShareLink({
        source: { kind: "paste" },
        markdown: "# Offline",
        base: "file:///home/docs/docwalk/index.html?token=x#intro/2",
      }),
    );
    expect(result.url.startsWith(`file:///home/docs/docwalk/index.html${DOC_HASH_PREFIX}`)).toBe(
      true,
    );
    expect(await readFragment(new URL(result.url).hash)).toBe("# Offline");
  });

  test("a fragment link is the app path plus the encoded Markdown and nothing else", async () => {
    // The builder takes no token input; this pins that nothing else (a
    // sessionStorage token, viewer state) is ever appended to the link.
    const markdown = "# Doc";
    const result = link(await buildShareLink({ source: { kind: "paste" }, markdown, base: BASE }));
    expect(result.url).toBe(`${BASE}${DOC_HASH_PREFIX}${await encodeDoc(markdown)}`);
  });
});
