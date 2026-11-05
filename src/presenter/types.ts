/**
 * Contract for the presenter window (decision 8, v1: same machine). The
 * audience window stays the source of truth: it owns the deck and announces
 * its state; the presenter window renders its own previews from the same
 * Markdown and sends navigation requests back. Transport: BroadcastChannel,
 * same origin only, so nothing leaves the machine.
 */

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
  /** Presenter -> audience: a new presenter window asks for the state. */
  | { type: "hello" };

/** Opens the presenter window (`?view=presenter`). Implemented in ./bridge.ts. */
export type OpenPresenterWindow = () => Window | null;
