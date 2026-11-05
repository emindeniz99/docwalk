import { describe, expect, test } from "vitest";
import { isApi, isBuildAsset, isOptInAsset, MAX_WARMUP_URLS, warmupUrls } from "./routes";

const ROOT = new URL("https://docwalk.example/");
// GitHub Pages serves a project site under /<repo>/ (decision 37).
const SUBPATH = new URL("https://owner.github.io/docwalk/");

describe("what the service worker may cache (decision 11)", () => {
  // /api carries OAuth token exchanges and remote-control rooms: a cached
  // answer would replay someone's token response or a stale room state.
  test("api paths are never build assets, at the root or under a subpath", () => {
    expect(isApi(new URL("/api/health", ROOT), ROOT)).toBe(true);
    expect(isBuildAsset(new URL("/api/health", ROOT), ROOT)).toBe(false);
    expect(isApi(new URL("/docwalk/api/token", SUBPATH), SUBPATH)).toBe(true);
    expect(isBuildAsset(new URL("/docwalk/api/token", SUBPATH), SUBPATH)).toBe(false);
  });

  test("only same-origin files under assets/ count as build assets", () => {
    expect(isBuildAsset(new URL("/assets/App-abc123.js", ROOT), ROOT)).toBe(true);
    expect(isBuildAsset(new URL("/docwalk/assets/App-abc123.js", SUBPATH), SUBPATH)).toBe(true);
    // A ?src= document on another host must always be fetched fresh.
    expect(isBuildAsset(new URL("https://raw.githubusercontent.com/assets/x.js"), ROOT)).toBe(
      false,
    );
    expect(isBuildAsset(new URL("/index.html", ROOT), ROOT)).toBe(false);
    // Outside the subpath is another site on the same origin.
    expect(isBuildAsset(new URL("/assets/x.js", SUBPATH), SUBPATH)).toBe(false);
  });
});

describe("canvas mode's fonts (decision 54)", () => {
  // Not precached, so a sketch opened online must leave its fonts in a cache,
  // or the same sketch offline draws every label in a fallback font.
  test("same-origin files under excalidraw-assets/ are cached on use, at the root or a subpath", () => {
    const font = "excalidraw-assets/fonts/Excalifont/Excalifont-Regular-a1.woff2";
    expect(isOptInAsset(new URL(`/${font}`, ROOT), ROOT)).toBe(true);
    expect(isOptInAsset(new URL(`/docwalk/${font}`, SUBPATH), SUBPATH)).toBe(true);
    expect(isOptInAsset(new URL(`https://esm.sh/${font}`), ROOT)).toBe(false);
    expect(isOptInAsset(new URL("/assets/App-abc123.js", ROOT), ROOT)).toBe(false);
  });
});

describe("warm-up messages from a page", () => {
  // The message comes from a page, which may run injected script if the
  // sanitizer ever fails; it must not be able to make the worker fetch and
  // store arbitrary URLs.
  test("keeps same-origin build assets and drops everything else", () => {
    const urls = warmupUrls(
      {
        type: "CACHE_URLS",
        urls: [
          "https://docwalk.example/assets/flowDiagram-1.js",
          "https://docwalk.example/api/health",
          "https://evil.example/assets/x.js",
          "https://docwalk.example/index.html",
          42,
          "http://[not a url",
        ],
      },
      ROOT,
    );
    expect(urls.map(String)).toEqual(["https://docwalk.example/assets/flowDiagram-1.js"]);
  });

  test("ignores messages of another shape", () => {
    expect(warmupUrls({ type: "SKIP_WAITING" }, ROOT)).toEqual([]);
    expect(warmupUrls({ type: "CACHE_URLS", urls: "not a list" }, ROOT)).toEqual([]);
    expect(warmupUrls(null, ROOT)).toEqual([]);
    expect(warmupUrls("CACHE_URLS", ROOT)).toEqual([]);
  });

  test("reads at most MAX_WARMUP_URLS entries, so one message cannot queue unbounded work", () => {
    const urls = Array.from({ length: MAX_WARMUP_URLS + 50 }, (_, i) => `/assets/c${i}.js`);
    expect(warmupUrls({ type: "CACHE_URLS", urls }, ROOT)).toHaveLength(MAX_WARMUP_URLS);
  });
});
