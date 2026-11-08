import { MAX_WARMUP_URLS } from "./routes";

/** A message to the service worker; `ServiceWorker.postMessage` takes no targetOrigin, it is same-origin by design. */
function tell(worker: ServiceWorker, message: object): void {
  // oxlint-disable-next-line unicorn/require-post-message-target-origin
  worker.postMessage(message);
}

/**
 * Hands the worker every file this page loaded while no worker controlled it
 * (`workerStart` 0): those never passed through its cache, so without this
 * the deck shown on the very first visit would not open offline. Loads that
 * finish while the worker is taking over are caught too, because the list
 * comes from a PerformanceObserver rather than one snapshot. The worker
 * keeps only the URLs it may (src/pwa/routes.ts).
 */
function warmWhenControlled(sw: ServiceWorkerContainer): void {
  let pending: string[] = [];
  const flush = () => {
    if (!sw.controller || pending.length === 0) return;
    tell(sw.controller, { type: "CACHE_URLS", urls: pending });
    pending = [];
  };
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries() as PerformanceResourceTiming[])
      if (!(entry.workerStart > 0) && pending.length < MAX_WARMUP_URLS) pending.push(entry.name);
    flush();
  }).observe({ type: "resource", buffered: true });
  sw.addEventListener("controllerchange", flush);
}

/** How long a visible, online tab waits between checks for a new version (decision 99). */
export const UPDATE_CHECK_MS = 60 * 60 * 1000;

/**
 * Asks the browser to fetch `sw.js` again while the page stays open. The
 * browser checks on navigation and about once a day; a deck left open for a
 * conference week would otherwise never see a release. Only a visible tab
 * that reports itself online asks, and a failed check says nothing: the next
 * one tries again. The request goes to this origin's own `sw.js` (rule 8).
 */
function checkForUpdatesWhileOpen(registration: ServiceWorkerRegistration): void {
  let last = Date.now();
  const check = () => {
    if (document.visibilityState !== "visible" || !navigator.onLine) return;
    last = Date.now();
    registration.update().catch(() => undefined);
  };
  setInterval(check, UPDATE_CHECK_MS);
  // A hidden tab skips its tick; coming back to it should not wait a whole interval more.
  document.addEventListener("visibilitychange", () => {
    if (Date.now() - last >= UPDATE_CHECK_MS) check();
  });
}

/**
 * Registers the service worker (src/pwa/sw.ts) and reports a waiting update.
 * Production builds only: the dev server has no sw.js.
 *
 * `onUpdate` receives `apply`, which tells the waiting worker to take over
 * and reloads this page once it has. Nothing reloads without that call, and
 * a first install (no previous worker) is not an update.
 */
export function registerServiceWorker(
  onUpdate: (apply: () => void) => void,
  reload: () => void = () => location.reload(),
): void {
  if (!("serviceWorker" in navigator)) return;
  const sw = navigator.serviceWorker;
  const base = import.meta.env.BASE_URL;
  let reloading = false;

  const offer = (worker: ServiceWorker) =>
    onUpdate(() => {
      // Another tab applied this update already: the worker is active, no
      // controllerchange is coming, and only a reload loads the new version.
      if (worker.state !== "installed") {
        reload();
        return;
      }
      reloading = true;
      tell(worker, { type: "SKIP_WAITING" });
    });

  sw.addEventListener("controllerchange", () => {
    if (reloading) reload();
  });
  warmWhenControlled(sw);

  void sw
    .register(`${base}sw.js`, { scope: base })
    .then((registration) => {
      checkForUpdatesWhileOpen(registration);
      if (registration.waiting && sw.controller) offer(registration.waiting);
      registration.addEventListener("updatefound", () => {
        const worker = registration.installing;
        worker?.addEventListener("statechange", () => {
          if (worker.state === "installed" && sw.controller) offer(worker);
        });
      });
    })
    // Offline support is an extra: a refused registration (private mode,
    // storage blocked) leaves the online app exactly as it was.
    .catch(() => undefined);
}
