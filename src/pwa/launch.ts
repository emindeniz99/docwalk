/** The part of Chromium's launch queue that docwalk uses (the manifest's `file_handlers`, decision 99). */
interface LaunchQueue {
  setConsumer(consumer: (params: { files: readonly { getFile(): Promise<File> }[] }) => void): void;
}

/**
 * Hands `open` the first file a launch from the OS names. Chromium only;
 * elsewhere there is no `launchQueue` and nothing happens. A file that cannot
 * be read any more (moved, permission gone) is skipped: the app shows what
 * it would have shown without the launch.
 */
export function consumeLaunchedFile(
  open: (file: File) => void | Promise<void>,
  queue = (window as { launchQueue?: LaunchQueue }).launchQueue,
): void {
  queue?.setConsumer(async ({ files }) => {
    const handle = files[0];
    if (!handle) return;
    let file: File;
    try {
      file = await handle.getFile();
    } catch {
      return;
    }
    await open(file);
  });
}

const nextFrames = (done: () => void) => requestAnimationFrame(() => requestAnimationFrame(done));
const findApp = () => document.querySelector(".docwalk-app");

/** Resolves once the main view is on the page and its start-up effects have run. */
function appMounted(): Promise<Element> {
  return new Promise((resolve) => {
    const settle = (app: Element) => nextFrames(() => resolve(app));
    const now = findApp();
    if (now) return settle(now);
    const observer = new MutationObserver(() => {
      const app = findApp();
      if (!app) return;
      observer.disconnect();
      settle(app);
    });
    observer.observe(document.body, { childList: true, subtree: true });
  });
}

/**
 * Opens a file in the main view the way a dropped file opens: the same
 * unsaved-changes guard, type check, size cap and UTF-8 check. Chromium
 * delivers a launch before the app has mounted, and the app's own start-up
 * (sample deck, share link) would replace a file loaded sooner, so this waits
 * for the app and its first effects.
 */
export async function openLikeADrop(file: File): Promise<void> {
  const app = await appMounted();
  const files = new DataTransfer();
  files.items.add(file);
  app.dispatchEvent(
    new DragEvent("drop", { dataTransfer: files, bubbles: true, cancelable: true }),
  );
}
