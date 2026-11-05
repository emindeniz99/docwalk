import { useEffect, useState } from "react";
import type { DeckController } from "../deck/controller";
import { connectRoom, type RemoteStatus, type SocketFactory } from "./client";
import type { RemoteMessage, RoomCredentials } from "./types";

/**
 * A follower window (`?view=follow#room=..&k=..`): it shows the same slide as
 * the presenter. The document is not sent over the room; the presenter's
 * state carries a share link that the app loads first.
 */

export type FollowState = Omit<Extract<RemoteMessage, { type: "state" }>, "type">;

export interface RemoteFollowerOptions {
  /** From `parseJoinFragment(location.hash)`; null connects nothing. */
  creds: RoomCredentials | null;
  /** The follower's deck once its document has loaded; null until then. */
  controller: DeckController | null;
  socketFactory?: SocketFactory;
  /** The follower page's URL; defaults to the current location. */
  base?: string;
}

export interface RemoteFollower {
  status: RemoteStatus;
  /**
   * The presenter's latest state. `docLink` is null unless it points at this
   * app's own origin: any key holder can send a state, and a follower must
   * not be steered to another site.
   */
  state: FollowState | null;
}

/**
 * Goes to the presenter's slide. Pagination is measured per viewport
 * (decision 21), so a follower on another screen may split a section into
 * fewer pages and lack `<section>/<n>`: it then shows the last page of that
 * section it has, rather than staying on a stale slide.
 */
export function followAddress(controller: DeckController, address: string): void {
  if (controller.goTo(address)) return;
  const cut = address.lastIndexOf("/");
  if (cut < 0) return;
  const sectionId = address.slice(0, cut);
  const page = Number(address.slice(cut + 1));
  let target: string | null = null;
  for (const slide of controller.slides()) {
    if (slide.sectionId !== sectionId) continue;
    // Pages come in order, so the last one at or below `page` wins; page 1 when none is.
    if (target === null || slide.page <= page) target = slide.address;
  }
  if (target) controller.goTo(target);
}

/** `followedDocument` when the presenter has no link to send. */
export const NO_DOC_LINK = "none";

/**
 * The document a follower should show for `state`: the link to load,
 * `NO_DOC_LINK` when the presenter has none to send (the follower says so),
 * or null while the presenter is still building it (nothing to do yet: a
 * presenter that just joined sends state before its link is ready).
 */
export function followedDocument(state: FollowState): string | null {
  return state.docLink ?? (state.docLinkTooLong ? NO_DOC_LINK : null);
}

/** The link when it is on `base`'s origin, else null. */
export function sameOriginLink(link: string | null, base: string): string | null {
  if (!link) return null;
  try {
    return new URL(link).origin === new URL(base).origin ? link : null;
  } catch {
    return null;
  }
}

export function useRemoteFollower({
  creds,
  controller,
  socketFactory,
  base,
}: RemoteFollowerOptions): RemoteFollower {
  const [status, setStatus] = useState<RemoteStatus>("connecting");
  const [state, setState] = useState<FollowState | null>(null);
  const room = creds?.room;
  const key = creds?.key;
  // Only the origin matters, and it does not change when URL sync rewrites the address bar.
  const origin = new URL(base ?? globalThis.location.href).origin;

  useEffect(() => {
    if (!room || !key) return;
    let active = true;
    // connectRoom sends `hello` on every (re)connect; the presenter answers with state.
    const conn = connectRoom({
      creds: { room, key },
      role: "follower",
      onMessage: (message) => {
        if (!active || message.type !== "state") return;
        const { type: _type, ...rest } = message;
        const docLink = sameOriginLink(rest.docLink, origin);
        // A link to another site is dropped, and the follower is told it has no document.
        const docLinkTooLong = rest.docLinkTooLong || (rest.docLink !== null && docLink === null);
        setState({ ...rest, docLink, docLinkTooLong });
      },
      onStatus: (next) => {
        if (active) setStatus(next);
      },
      base: origin,
      ...(socketFactory ? { socketFactory } : {}),
    });
    return () => {
      active = false;
      conn.close();
      setStatus("connecting");
    };
  }, [room, key, origin, socketFactory]);

  // Runs for each new state and again when the deck becomes ready or is rebuilt.
  useEffect(() => {
    if (controller && state) followAddress(controller, state.current);
  }, [controller, state]);

  return { status: room && key ? status : "closed", state };
}
