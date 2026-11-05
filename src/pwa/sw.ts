/**
 * docwalk's service worker (decision 11): the app opens and presents offline.
 *
 * - The app shell and docwalk's own lazy chunks are precached at install
 *   (the list comes from `tooling/pwa-plugin.ts`, see `selectPrecache`).
 * - Other build assets, chiefly Mermaid's per-diagram-type chunks, are
 *   cached the first time a deck loads them, then served from the cache.
 * - Canvas mode's fonts (`excalidraw-assets/`) are cached when a sketch
 *   uses them and refreshed in the background, as some names carry no hash.
 * - Navigations get the precached `index.html`, except under `api/`.
 * - `api/` requests and every other origin are never answered by this
 *   worker: no route matches them, so the browser goes to the network.
 * - A new version waits until the page asks it to take over ("Reload" in
 *   the update prompt), so a talk is never reloaded underneath a presenter.
 */
import { clientsClaim } from "workbox-core";
import { ExpirationPlugin } from "workbox-expiration";
import {
  cleanupOutdatedCaches,
  createHandlerBoundToURL,
  getCacheKeyForURL,
  precacheAndRoute,
  type PrecacheEntry,
} from "workbox-precaching";
import { NavigationRoute, registerRoute } from "workbox-routing";
import { CacheFirst, StaleWhileRevalidate } from "workbox-strategies";
import { isApi, isBuildAsset, isOptInAsset, warmupUrls } from "./routes";

declare const self: ServiceWorkerGlobalScope;
/** Replaced at build time with the precache list. */
declare const DOCWALK_PRECACHE: PrecacheEntry[];

const scope = new URL(self.registration.scope);

precacheAndRoute(DOCWALK_PRECACHE);
cleanupOutdatedCaches();

// The first install takes control at once, so the chunks this visit loads
// from now on pass through the runtime cache. An update still waits for the
// page (no skipWaiting here): until then the old worker stays in charge.
clientsClaim();

registerRoute(
  new NavigationRoute(createHandlerBoundToURL("index.html"), {
    denylist: [new RegExp(`^${scope.pathname.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}api/`)],
  }),
);

const lazyAssets = new CacheFirst({
  cacheName: "docwalk-runtime",
  // A dev or preview server may answer module loads with `Vary: Origin`; the
  // file behind a hashed name is the same whatever the request headers.
  matchOptions: { ignoreVary: true },
  plugins: [
    // Old versions' chunks accumulate across deploys; keep the most recent
    // couple of hundred files (one full build of diagram types is ~100) and
    // give way first when the browser runs short of storage.
    new ExpirationPlugin({ maxEntries: 200, purgeOnQuotaError: true }),
  ],
});

registerRoute(
  ({ url, request }) => request.method === "GET" && isBuildAsset(url, scope) && !isApi(url, scope),
  lazyAssets,
);

registerRoute(
  ({ url, request }) => request.method === "GET" && isOptInAsset(url, scope),
  new StaleWhileRevalidate({
    cacheName: "docwalk-canvas-fonts",
    matchOptions: { ignoreVary: true },
    plugins: [new ExpirationPlugin({ maxEntries: 300, purgeOnQuotaError: true })],
  }),
);

self.addEventListener("message", (event) => {
  const data: unknown = event.data;
  if (
    typeof data === "object" &&
    data !== null &&
    (data as { type?: unknown }).type === "SKIP_WAITING"
  ) {
    void self.skipWaiting();
    return;
  }
  // Files the page loaded before this worker controlled it; caching them now
  // means the deck shown during the very first visit also opens offline.
  const urls = warmupUrls(data, scope).filter((url) => getCacheKeyForURL(url.href) === undefined);
  if (urls.length === 0) return;
  event.waitUntil(
    Promise.allSettled(
      urls.map((url) => lazyAssets.handle({ event, request: new Request(url.href) })),
    ),
  );
});
