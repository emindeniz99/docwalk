/**
 * Contract for the presenter window (decision 8, v1: same machine). The
 * audience window stays the source of truth: it owns the deck and announces
 * its state; the presenter window renders its own previews from the same
 * Markdown and sends navigation requests back. Transport: BroadcastChannel,
 * same origin only, so nothing leaves the machine.
 */

import type { MirrorOp } from "../annotate/mirrorTypes";
import type { Countdown } from "./pacing";

export const PRESENTER_CHANNEL = "docwalk-presenter";

export type PresenterMessage =
  /** Audience -> presenter: the full state, sent on connect and on every change. */
  | {
      type: "state";
      markdown: string;
      level: "auto" | number | number[];
      current: string;
      addresses: string[];
      startedAt: number;
    }
  /** Presenter -> audience: ask for a slide by address. */
  | { type: "goto"; address: string }
  /** Presenter -> audience: next / previous. */
  | { type: "step"; direction: 1 | -1 }
  /**
   * Presenter -> audience: a presenter window asks for the state. `resync`, on
   * its first hello, also asks for the current slide's marks (decision 88).
   */
  | { type: "hello"; resync?: boolean }
  /**
   * Presenter -> audience: the presenter window's countdown, or null once it is
   * reset (decision 112). Sent on each change and after each heartbeat hello;
   * only the audience tab checks it, and forgets it 5 s after the last one.
   */
  | { type: "countdown"; countdown: Countdown | null }
  /** Audience -> presenter: the audience window's laser or pen marks (decision 88). */
  | ({ type: "mirror" } & MirrorOp);

// `OpenPresenterWindow` lives in ./window.ts: this file stays free of DOM
// types so the Node-run bridge tests can import it (tsconfig.node.json has
// no DOM lib).
