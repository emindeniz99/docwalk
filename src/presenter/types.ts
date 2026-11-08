/**
 * Contract for the presenter window (decision 8, v1: same machine). The
 * audience window stays the source of truth: it owns the deck and announces
 * its state; the presenter window renders its own previews from the same
 * Markdown and sends navigation requests back. Transport: BroadcastChannel,
 * same origin only, so nothing leaves the machine.
 */

import type { MirrorOp } from "../annotate/mirrorTypes";

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
  /** Audience -> presenter: the audience window's laser or pen marks (decision 88). */
  | ({ type: "mirror" } & MirrorOp);

// `OpenPresenterWindow` lives in ./window.ts: this file stays free of DOM
// types so the Node-run bridge tests can import it (tsconfig.node.json has
// no DOM lib).
