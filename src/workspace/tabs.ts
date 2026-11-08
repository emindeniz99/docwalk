/**
 * The browser workspace in several tabs (decision 90). OPFS is shared by every
 * tab of the origin, and nothing tells a tab that another one wrote, so tabs
 * announce what they did on a `BroadcastChannel` and take a Web Lock around
 * "look at the file, then write it".
 *
 * A message carries no paths and no text: it only says that the listing
 * (`tree`) or a file's text (`file`) changed. A receiver reads the disk, so a
 * stale or forged message costs one read and nothing else.
 */

/** The channel every tab of the origin listens on. */
const CHANNEL = "docwalk-workspace";
/** Held while a tab compares a file with the disk and writes it. */
const WRITE_LOCK = "docwalk-workspace-write";

export type TabChange = "tree" | "file";

export interface TabChannel {
  announce: (kind: TabChange) => void;
  close: () => void;
}

/**
 * Listens for the other tabs' announcements and returns the way to make one.
 * A channel does not hear its own messages, but another channel in the same
 * page does, which is how the tests stand in for a second tab. `null` where
 * `BroadcastChannel` does not exist: a single tab then behaves as it always did.
 */
export function openTabChannel(onChange: (kind: TabChange) => void): TabChannel | null {
  if (typeof BroadcastChannel === "undefined") return null;
  try {
    const channel = new BroadcastChannel(CHANNEL);
    channel.addEventListener("message", (event: MessageEvent<unknown>) => {
      if (event.data === "tree" || event.data === "file") onChange(event.data);
    });
    return {
      announce: (kind) => {
        try {
          channel.postMessage(kind);
        } catch {
          // A closed channel: the other tabs still check when they regain focus.
        }
      },
      close: () => channel.close(),
    };
  } catch {
    return null;
  }
}

/**
 * Runs `run` while no other tab writes the workspace. Where Web Locks are
 * missing it runs at once: the check and the write can then be interleaved by
 * another tab, which the next check still finds.
 */
export function withWriteLock<T>(run: () => Promise<T>): Promise<T> {
  const locks = typeof navigator === "undefined" ? undefined : navigator.locks;
  return locks ? locks.request(WRITE_LOCK, run) : run();
}
