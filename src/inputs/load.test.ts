import { describe, expect, test, vi } from "vitest";
import {
  checkUrlPolicy,
  loadFromFile,
  loadFromRepo,
  loadFromUrl,
  parseInputUrl,
  type FetchLike,
} from "./load";
import { MAX_DOCUMENT_BYTES } from "./types";

const RAW = "https://raw.githubusercontent.com/acme/docs/main/README.md";

/** A fake fetch that records every call and answers with `respond`. */
function fakeFetch(respond: (url: string, init?: RequestInit) => Response) {
  return vi.fn<FetchLike>(async (url, init) => respond(url, init));
}

const text = (body: string, init: ResponseInit = {}) =>
  new Response(body, { headers: { "content-type": "text/plain; charset=utf-8" }, ...init });

/** A body that streams `chunks` × `size` bytes and records how far it was read. */
function streamingBody(chunks: number, size: number) {
  const state = { pulled: 0, cancelled: false };
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (state.pulled === chunks) return controller.close();
      state.pulled += 1;
      controller.enqueue(new Uint8Array(size).fill(0x61));
    },
    cancel() {
      state.cancelled = true;
    },
  });
  return { stream, state };
}

const trusted = (url: string) => {
  const check = checkUrlPolicy(url);
  return check.ok && check.trusted;
};

const urlAt = (status: number) =>
  loadFromUrl(RAW, { fetch: fakeFetch(() => text("", { status })) });

const parse = (query: string) => parseInputUrl(`https://docwalk.example/${query}`);

const request = { repo: "acme/docs", path: "docs/my design.md", ref: "main", token: null };

const repoAt = (status: number, headers: Record<string, string> = {}) =>
  loadFromRepo(request, { fetch: fakeFetch(() => text("{}", { status, headers })) });

describe("URL policy (decision 6): every ?src= is hostile", () => {
  test.each([
    ["javascript:", "javascript:alert(1)"],
    ["data:", "data:text/markdown,%23%20hi"],
    ["http:", "http://raw.githubusercontent.com/a/b/main/x.md"],
    ["file:", "file:///etc/passwd"],
    ["not a URL", "raw.githubusercontent.com/a/b"],
  ])("%s is refused before any request", async (_name, url) => {
    const fetch = fakeFetch(() => text("never"));
    const result = await loadFromUrl(url, { fetch, confirmed: true });
    expect(result).toMatchObject({ ok: false, error: { kind: "invalid" } });
    expect(fetch).not.toHaveBeenCalled();
  });

  test("credentials in the address are refused, even on a trusted host, so they never travel or show", async () => {
    for (const url of [
      "https://user:pass@raw.githubusercontent.com/a/b/main/x.md",
      "https://token@raw.githubusercontent.com/a/b/main/x.md",
      // The classic trick: the trusted name is the user part, evil.example is the host.
      "https://raw.githubusercontent.com@evil.example/x.md",
    ]) {
      expect(checkUrlPolicy(url).ok).toBe(false);
    }
  });

  test("only the exact raw GitHub hosts on the default port are trusted", () => {
    expect(trusted(RAW)).toBe(true);
    expect(trusted("https://gist.githubusercontent.com/u/abc/raw/doc.md")).toBe(true);
    expect(trusted("https://raw.githubusercontent.com.evil.example/x.md")).toBe(false);
    expect(trusted("https://evilraw.githubusercontent.com/x.md")).toBe(false);
    expect(trusted("https://raw.githubusercontent.com:8443/x.md")).toBe(false);
    expect(trusted("https://github.com/acme/docs/blob/main/README.md")).toBe(false);
  });

  test("an IDN lookalike is untrusted and its prompt names the punycode host, not the name it imitates", async () => {
    // Cyrillic "с" (U+0441) in place of the Latin c.
    const lookalike = "https://raw.githubuserсontent.com/acme/docs/main/README.md";
    const fetch = fakeFetch(() => text("never"));
    const result = await loadFromUrl(lookalike, { fetch });
    expect(fetch).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    if (result.ok || result.error.kind !== "needs-confirmation")
      throw new Error("expected a prompt");
    expect(result.error.host).toMatch(/^raw\.xn--/);
    expect(result.error.host).not.toContain("githubusercontent.com");
  });

  test("another https host needs a confirmation and sends no request until confirmed", async () => {
    const fetch = fakeFetch(() => text("# Notes"));
    const url = "https://docs.example.org/design.md";
    expect(await loadFromUrl(url, { fetch })).toEqual({
      ok: false,
      error: { kind: "needs-confirmation", url, host: "docs.example.org" },
    });
    expect(fetch).not.toHaveBeenCalled();
    const confirmed = await loadFromUrl(url, { fetch, confirmed: true });
    expect(confirmed).toEqual({
      ok: true,
      doc: { markdown: "# Notes", source: { kind: "url", url, trusted: false } },
    });
  });
});

describe("loadFromUrl", () => {
  test("a trusted host loads directly, without cookies or a referrer", async () => {
    const fetch = fakeFetch(() => text("# Title\n"));
    const result = await loadFromUrl(RAW, { fetch });
    expect(result).toEqual({
      ok: true,
      doc: { markdown: "# Title\n", source: { kind: "url", url: RAW, trusted: true } },
    });
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({
      credentials: "omit",
      referrerPolicy: "no-referrer",
    });
  });

  test("a huge declared Content-Length is refused without reading the body", async () => {
    const { stream, state } = streamingBody(10, 1024);
    const fetch = fakeFetch(
      () =>
        new Response(stream, {
          headers: { "content-type": "text/plain", "content-length": "99999999999999" },
        }),
    );
    const result = await loadFromUrl(RAW, { fetch });
    expect(result).toEqual({ ok: false, error: { kind: "too-large", bytes: 99999999999999 } });
    expect(state.pulled).toBeLessThanOrEqual(1);
  });

  test("a body without Content-Length is cut off just past the cap, so a lying server cannot exhaust memory", async () => {
    const chunk = 256 * 1024;
    const { stream, state } = streamingBody(1000, chunk); // 250 MB if read to the end
    const fetch = fakeFetch(
      () => new Response(stream, { headers: { "content-type": "text/plain" } }),
    );
    const result = await loadFromUrl(RAW, { fetch });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("too-large");
    expect(state.cancelled).toBe(true);
    expect(state.pulled * chunk).toBeLessThanOrEqual(MAX_DOCUMENT_BYTES + 2 * chunk);
  });

  test("a document of exactly the cap still loads", async () => {
    const body = "a".repeat(MAX_DOCUMENT_BYTES);
    const result = await loadFromUrl(RAW, { fetch: fakeFetch(() => text(body)) });
    expect(result.ok && result.doc.markdown.length).toBe(MAX_DOCUMENT_BYTES);
  });

  test.each(["text/html", "text/markdown", "application/octet-stream", ""])(
    "content type %j is accepted as text",
    async (type) => {
      const response = new Response("# x");
      if (type) response.headers.set("content-type", type);
      else response.headers.delete("content-type");
      expect((await loadFromUrl(RAW, { fetch: fakeFetch(() => response) })).ok).toBe(true);
    },
  );

  test.each(["image/svg+xml", "application/json", "application/javascript"])(
    "content type %s is refused: docwalk renders Markdown, not whatever a server sends",
    async (type) => {
      const response = new Response("{}", { headers: { "content-type": type } });
      const result = await loadFromUrl(RAW, { fetch: fakeFetch(() => response) });
      expect(result).toMatchObject({ ok: false, error: { kind: "invalid" } });
    },
  );

  test("binary that is not UTF-8 is refused rather than shown as garbage", async () => {
    const response = new Response(new Uint8Array([0xff, 0xfe, 0x00, 0xc3]), {
      headers: { "content-type": "application/octet-stream" },
    });
    const result = await loadFromUrl(RAW, { fetch: fakeFetch(() => response) });
    expect(result).toMatchObject({ ok: false, error: { kind: "invalid" } });
  });

  test("HTTP errors map to typed errors the banner can explain", async () => {
    expect(await urlAt(404)).toEqual({ ok: false, error: { kind: "not-found" } });
    expect(await urlAt(401)).toEqual({ ok: false, error: { kind: "unauthorized" } });
    expect(await urlAt(500)).toMatchObject({ ok: false, error: { kind: "network" } });
  });

  test("a thrown fetch (offline, CORS) becomes a network error, not an exception", async () => {
    const fetch = vi.fn<FetchLike>(async () => {
      throw new TypeError("Failed to fetch");
    });
    expect(await loadFromUrl(RAW, { fetch })).toMatchObject({
      ok: false,
      error: { kind: "network" },
    });
  });

  test("a redirect from a trusted host to another host asks again instead of loading", async () => {
    const response = text("# moved");
    Object.defineProperty(response, "url", { value: "https://evil.example/doc.md" });
    const result = await loadFromUrl(RAW, { fetch: fakeFetch(() => response) });
    expect(result).toEqual({
      ok: false,
      error: {
        kind: "needs-confirmation",
        url: "https://evil.example/doc.md",
        host: "evil.example",
      },
    });
  });
});

describe("parseInputUrl", () => {
  test("no document parameter means the default document", () => {
    expect(parse("")).toBeNull();
    expect(parse("?level=2#intro/1")).toBeNull();
  });

  test("?src= gives a url request", () => {
    expect(parse(`?src=${encodeURIComponent(RAW)}`)).toEqual({ kind: "url", url: RAW });
  });

  test("a hostile ?src= is reported, so the user sees why nothing loaded", () => {
    // Exact shape: callers switch on `kind` and show `message`; nothing else rides along.
    expect(parse("?src=javascript:alert(1)")).toEqual({
      kind: "invalid",
      message: "Only https:// addresses can be loaded.",
    });
    expect(
      parse(`?src=${encodeURIComponent("https://a:b@raw.githubusercontent.com/x")}`),
    ).toMatchObject({
      kind: "invalid",
    });
  });

  test("?repo=&path=&ref= gives a repo request; a missing or empty ref is null", () => {
    expect(parse("?repo=acme/docs&path=docs/design.md&ref=release/1.2")).toEqual({
      kind: "repo",
      repo: "acme/docs",
      path: "docs/design.md",
      ref: "release/1.2",
    });
    expect(parse("?repo=acme/docs&path=README.md&ref=")).toMatchObject({ ref: null });
    expect(parse("?repo=acme/docs&path=README.md")).toMatchObject({ ref: null });
  });

  test.each([
    ["path traversal", "?repo=acme/docs&path=../../user"],
    ["absolute path", "?repo=acme/docs&path=/etc/passwd"],
    ["empty segment", "?repo=acme/docs&path=docs//x.md"],
    ["backslash", "?repo=acme/docs&path=docs%5Cx.md"],
    ["control character", "?repo=acme/docs&path=x%0A.md"],
    ["repo without name", "?repo=acme&path=README.md"],
    ["repo with extra segment", "?repo=acme/docs/x&path=README.md"],
    ["repo named ..", "?repo=acme/..&path=README.md"],
    ["owner with leading hyphen", "?repo=-acme/docs&path=README.md"],
    ["ref with ..", "?repo=acme/docs&path=README.md&ref=main..x"],
    ["ref with a query", "?repo=acme/docs&path=README.md&ref=main%3Fx%3D1"],
    ["path without repo", "?path=README.md"],
    ["both src and repo", `?src=${encodeURIComponent(RAW)}&repo=acme/docs&path=README.md`],
    ["repeated parameter", "?repo=acme/docs&repo=evil/docs&path=README.md"],
  ])("%s is invalid, never guessed at", (_name, query) => {
    expect(parse(query)).toMatchObject({ kind: "invalid" });
  });
});

describe("loadFromRepo", () => {
  test("calls the contents API with the raw media type and returns the text", async () => {
    const fetch = fakeFetch(
      () => new Response("# Design", { headers: { "content-type": "application/vnd.github.raw" } }),
    );
    const result = await loadFromRepo(request, { fetch });
    expect(result).toEqual({
      ok: true,
      doc: {
        markdown: "# Design",
        source: { kind: "repo", repo: "acme/docs", path: "docs/my design.md", ref: "main" },
      },
    });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(
      "https://api.github.com/repos/acme/docs/contents/docs/my%20design.md?ref=main",
    );
    expect(init?.headers).toMatchObject({ Accept: "application/vnd.github.raw" });
    expect(init?.headers).not.toHaveProperty("Authorization");
  });

  test("a token goes into the Authorization header, and only there", async () => {
    const token = "github_pat_" + "A".repeat(40);
    const fetch = fakeFetch(() => text("# Private"));
    await loadFromRepo({ ...request, token }, { fetch });
    const [url, init] = fetch.mock.calls[0]!;
    expect(init?.headers).toMatchObject({ Authorization: `Bearer ${token}` });
    expect(url).not.toContain(token);
  });

  test("401 and 403 mean the token cannot read the repo; 404 means not found", async () => {
    expect(await repoAt(401)).toEqual({ ok: false, error: { kind: "unauthorized" } });
    expect(await repoAt(403)).toEqual({ ok: false, error: { kind: "unauthorized" } });
    expect(await repoAt(404)).toEqual({ ok: false, error: { kind: "not-found" } });
    // A rate limit is not a permission problem; telling the user to fix the token would mislead.
    expect(await repoAt(403, { "x-ratelimit-remaining": "0" })).toMatchObject({
      error: { kind: "network" },
    });
  });

  test("a folder (JSON listing) is refused instead of rendered as a document", async () => {
    const fetch = fakeFetch(
      () => new Response("[]", { headers: { "content-type": "application/json" } }),
    );
    expect(await loadFromRepo(request, { fetch })).toMatchObject({ error: { kind: "invalid" } });
  });

  test("malformed parameters or tokens never reach the network", async () => {
    const fetch = fakeFetch(() => text("never"));
    for (const bad of [
      { ...request, repo: "acme/docs/../x" },
      { ...request, path: "../secrets" },
      { ...request, ref: "-delete" },
      { ...request, token: "ghp_x\r\nX-Evil: 1" },
    ]) {
      expect((await loadFromRepo(bad, { fetch })).ok).toBe(false);
    }
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("loadFromFile", () => {
  test("reads a Markdown file and names it as the source", async () => {
    const file = new File(["# Local"], "notes.md", { type: "text/markdown" });
    expect(await loadFromFile(file)).toEqual({
      ok: true,
      doc: { markdown: "# Local", source: { kind: "file", name: "notes.md" } },
    });
  });

  test("the picker's filter can be bypassed, so the extension is checked again", async () => {
    const file = new File(["<svg/>"], "image.svg");
    expect(await loadFromFile(file)).toMatchObject({ ok: false, error: { kind: "invalid" } });
  });

  test("a file that cannot be read (moved or deleted after picking) is a typed error, not a rejection", async () => {
    const file = new File(["# x"], "gone.md");
    Object.defineProperty(file, "arrayBuffer", {
      value: () => Promise.reject(new DOMException("gone", "NotFoundError")),
    });
    expect(await loadFromFile(file)).toEqual({
      ok: false,
      error: { kind: "invalid", message: "The file could not be read." },
    });
  });

  test("a file above the cap is refused before it is read", async () => {
    const file = new File([new Uint8Array(MAX_DOCUMENT_BYTES + 1)], "big.md");
    expect(await loadFromFile(file)).toEqual({
      ok: false,
      error: { kind: "too-large", bytes: MAX_DOCUMENT_BYTES + 1 },
    });
  });
});
