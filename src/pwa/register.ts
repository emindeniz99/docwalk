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

/**
 * Registers the service worker (src/pwa/sw.ts) and reports a waiting update.
 * Production builds only: the dev server has no sw.js.
 *
 * `onUpdate` receives `apply`, which tells the waiting worker to take over
 * and reloads this page once it has. Nothing reloads without that call, and
 * a first install (no previous worker) is not an update.
 */
export function registerServiceWorker(onUpdate: (apply: () => void) => void): void {
  if (!("serviceWorker" in navigator)) return;
  const sw = navigator.serviceWorker;
  const base = import.meta.env.BASE_URL;
  let reloading = false;

  const offer = (worker: ServiceWorker) =>
    onUpdate(() => {
      reloading = true;
      tell(worker, { type: "SKIP_WAITING" });
    });

  sw.addEventListener("controllerchange", () => {
    if (reloading) location.reload();
  });
  warmWhenControlled(sw);

  void sw
    .register(`${base}sw.js`, { scope: base })
    .then((registration) => {
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
