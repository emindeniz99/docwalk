import { useEffect } from "react";

/**
 * Screen Wake Lock (decision 80): the screen stays on while the presenter
 * talks. It is a courtesy, never a requirement, so every way it can fail
 * (no API, a refused request, a lock the browser takes back) leaves the app
 * as it was: no message, no console output, no retry loop. The browser drops
 * a lock when the page is hidden; the page asks again when it is shown.
 */

/** The part of a `WakeLockSentinel` this module uses. */
interface Sentinel {
  addEventListener(type: "release", listener: () => void): void;
  release(): Promise<void>;
}

/** The parts of the page this module uses, so a test can stand in for them. */
export interface WakeLockEnv {
  navigator: { wakeLock?: { request(type: "screen"): Promise<Sentinel> } | undefined };
  document: {
    visibilityState: string;
    addEventListener(type: "visibilitychange", listener: () => void): void;
    removeEventListener(type: "visibilitychange", listener: () => void): void;
  };
}

/** Runs `action`, and swallows a throw or a rejection. */
function quietly(action: () => Promise<unknown> | undefined): void {
  try {
    action()?.catch(() => {});
  } catch {
    // Not available or not allowed: the screen simply keeps its own timeout.
  }
}

/**
 * Asks for a screen lock now and keeps asking for one whenever the page is
 * shown without one. Returns the function that lets go and stops asking.
 */
export function holdScreenAwake(
  env: WakeLockEnv = { navigator, document } as WakeLockEnv,
): () => void {
  let wanted = true;
  let lock: Sentinel | null = null;
  let asking = false;

  const ask = () => {
    if (!wanted || lock || asking || env.document.visibilityState !== "visible") return;
    asking = true;
    quietly(async () => {
      try {
        const granted = await env.navigator.wakeLock?.request("screen");
        if (!granted) return;
        if (!wanted) {
          quietly(() => granted.release());
          return;
        }
        lock = granted;
        // The browser lets go by itself when the page is hidden.
        granted.addEventListener("release", () => {
          if (lock === granted) lock = null;
        });
      } finally {
        asking = false;
      }
    });
  };

  env.document.addEventListener("visibilitychange", ask);
  ask();

  return () => {
    wanted = false;
    env.document.removeEventListener("visibilitychange", ask);
    const held = lock;
    lock = null;
    if (held) quietly(() => held.release());
  };
}

/** Holds the screen awake while `active`. */
export function useWakeLock(active: boolean): void {
  useEffect(() => (active ? holdScreenAwake() : undefined), [active]);
}
