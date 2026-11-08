/**
 * Calls `run` over and over while the page is visible (decision 91): the tree
 * of a local folder in a browser without `FileSystemObserver`. It does not run
 * while the page is hidden, runs again at once when the page shows, and never
 * starts a run while the last one is going. After each run it waits at least
 * `slowdown` times as long as that run took, so listing a very large folder
 * costs a few percent of one core, whatever `minDelayMs` says.
 * Returns the function that stops it.
 */
export function pollWhileVisible(
  run: () => Promise<unknown>,
  minDelayMs: number,
  slowdown = 20,
): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let running = false;
  const visible = () => document.visibilityState === "visible";
  const schedule = (delay: number) => {
    clearTimeout(timer);
    if (!stopped) timer = setTimeout(() => void tick(), delay);
  };
  const tick = async () => {
    // Hidden: no timer is left running. The page showing again starts one.
    if (stopped || !visible()) return;
    if (running) {
      schedule(minDelayMs);
      return;
    }
    running = true;
    const started = performance.now();
    try {
      await run();
    } catch {
      // A failed run is the caller's to report; the next one tries again.
    } finally {
      running = false;
    }
    schedule(Math.max(minDelayMs, (performance.now() - started) * slowdown));
  };
  const onVisibility = () => {
    if (!visible()) return;
    clearTimeout(timer);
    void tick();
  };
  document.addEventListener("visibilitychange", onVisibility);
  schedule(minDelayMs);
  return () => {
    stopped = true;
    clearTimeout(timer);
    document.removeEventListener("visibilitychange", onVisibility);
  };
}
