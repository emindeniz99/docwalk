/**
 * Which requests the service worker may answer from a cache (decision 11).
 * Pure functions over URLs, shared by the worker and its tests. `scope` is
 * the registration scope, so a deploy under a subpath works the same.
 */

/** Paths under `<scope>api/` belong to the Worker (OAuth, remote rooms): always network, never cached. */
export function isApi(url: URL, scope: URL): boolean {
  return url.origin === scope.origin && url.pathname.startsWith(`${scope.pathname}api/`);
}

/**
 * Build output under `<scope>assets/`, same origin only. Vite puts a content
 * hash in every file name there, so a cached copy can never be stale and the
 * worker may serve it without asking the network.
 */
export function isBuildAsset(url: URL, scope: URL): boolean {
  return url.origin === scope.origin && url.pathname.startsWith(`${scope.pathname}assets/`);
}

/** Longest list one warm-up message may carry; a page loads about 150 files. */
export const MAX_WARMUP_URLS = 500;

/**
 * Reads a `{ type: "CACHE_URLS", urls }` message from a page: the build
 * assets it loaded before the worker controlled it, which never passed
 * through the worker's cache. Anything else in the message is ignored, and
 * only same-origin build assets survive, so a page cannot make the worker
 * fetch or store an arbitrary URL.
 */
export function warmupUrls(data: unknown, scope: URL): URL[] {
  if (typeof data !== "object" || data === null) return [];
  const { type, urls } = data as { type?: unknown; urls?: unknown };
  if (type !== "CACHE_URLS" || !Array.isArray(urls)) return [];
  const result: URL[] = [];
  for (const raw of urls.slice(0, MAX_WARMUP_URLS)) {
    if (typeof raw !== "string") continue;
    let url: URL;
    try {
      url = new URL(raw, scope);
    } catch {
      continue;
    }
    if (isBuildAsset(url, scope) && !isApi(url, scope)) result.push(url);
  }
  return result;
}
