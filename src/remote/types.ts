/**
 * Remote control and followers (decision 8, moved into v1 on 2026-11-05).
 *
 * A presenter opens a room; phones join as remotes, other devices as
 * followers, by QR code or link: `<origin>/?view=remote#room=<id>&k=<key>` or
 * `?view=follow#room=<id>&v=<key>&p=<state key>`. The keys never reach the server: they live
 * in the URL fragment. The control key (`k`) steers the deck and reads and
 * writes the document; the view key (`v`) only follows (decision 68). Every
 * frame on the wire is an `EncryptedFrame`; the
 * relay (worker/) only forwards bytes. The document itself is never sent:
 * followers load it from the share link (`?src=`, `?repo=` or `#doc=`), which
 * the presenter includes in its `hello`.
 *
 * Agents (decision 59) are the exception: a local MCP server (`mcp/`) joins
 * with a room's link and asks the presenter for the document, the slide list,
 * or a document write. Those messages are addressed (`from` on a request,
 * `to` on its answer) and can be larger than a relay frame, so they travel as
 * encrypted `part`s (src/remote/parts.ts). The presenter applies a write only
 * while "Allow agent edits" is on.
 */

import type { HeadingDepth } from "../sectioning/sectionize";

/** Plaintext messages, encrypted before sending. */
export type RemoteMessage =
  /** Presenter -> all: where the deck is. Sent on join and on every change. */
  | {
      type: "state";
      current: string;
      index: number;
      total: number;
      title: string;
      /** Share link a follower opens to load the same document; null while it is being built. */
      docLink: string | null;
      /** True when the presenter has no link to send: the document is too long for a link or for the relay. */
      docLinkTooLong: boolean;
      /** The presenter's slide level: section ids, and so addresses, depend on it. */
      level: "auto" | HeadingDepth | HeadingDepth[];
    }
  /** Remote -> presenter: next/previous slide. */
  | { type: "step"; direction: 1 | -1 }
  /** Remote -> presenter: jump to an address. */
  | { type: "goto"; address: string }
  /** Remote -> presenter: laser position in slide coordinates (0..1), or null to hide. */
  | { type: "laser"; x: number; y: number }
  | { type: "laser-off" }
  /**
   * Any -> presenter: announce a participant and ask for state. Sent on every
   * (re)connect; `id` is random per page load, so the presenter can count
   * devices without a reconnect counting twice.
   */
  | { type: "hello"; role: "remote" | "follower" | "agent"; id: string }
  /** Agent -> presenter: send me the document. `from` is the agent's hello id. */
  | { type: "doc-get"; request: string; from: string }
  /** Presenter -> one agent: the document and its revision (a hash of the text). */
  | { type: "doc"; request: string; to: string; markdown: string; revision: string }
  /**
   * Agent -> presenter: replace the document. `name` is shown to the presenter
   * as the author; `base`, when set, is the revision the agent edited, and the
   * write is refused when the document changed since.
   */
  | {
      type: "doc-write";
      request: string;
      from: string;
      name: string;
      markdown: string;
      base: string | null;
    }
  /** Agent -> presenter: send me the slide list. */
  | { type: "slides-get"; request: string; from: string }
  /** Presenter -> one agent: the deck as it is rendered now, notes included. */
  | {
      type: "slides";
      request: string;
      to: string;
      current: string | null;
      slides: AgentSlide[];
    }
  /** Presenter -> one agent: the outcome of a `doc-write`, or why a request failed. */
  | { type: "result"; request: string; to: string; ok: true; revision: string }
  | { type: "result"; request: string; to: string; ok: false; error: AgentError }
  /** One piece of a message too large for a relay frame, for one participant (parts.ts). */
  | { type: "part"; to: string; id: string; seq: number; total: number; data: string };

/** One slide as an agent sees it. `note` is the slide's diagnostic (overflow, diagram error). */
export interface AgentSlide {
  address: string;
  title: string;
  note: string | null;
}

/**
 * Why the presenter refused an agent's request:
 * - `edits-off`: "Allow agent edits" is off in the remote dialog.
 * - `conflict`: the document changed since the revision the agent edited.
 * - `no-document`: the presenter's document is still loading.
 * - `too-large`: the answer or the write is over the size limits.
 */
export type AgentError = "edits-off" | "conflict" | "no-document" | "too-large";

/** The recipient id of messages for the presenter, which sends no hello. */
export const PRESENTER_ID = "presenter";

/**
 * The close code the relay (worker/room.ts) ends a socket with when its seat
 * token is not the room's: someone else's key holds the control seats
 * (decision 74). In the 4000-4999 range the WebSocket protocol leaves to applications.
 */
export const SEAT_TAKEN_CLOSE = 4409;

/** What travels over the WebSocket: AES-GCM ciphertext and its IV, base64url. */
export interface EncryptedFrame {
  v: 2;
  iv: string;
  data: string;
}

/**
 * A room and the keys a participant holds, each a raw 256-bit AES-GCM key,
 * base64url. The presenter holds both; a remote link carries only `key`, a
 * follow link `view` and `verify`.
 */
export interface RoomCredentials {
  room: string;
  /** Control key: steer the deck, read and write the document (`k=`). */
  key: string | null;
  /** View key: receive the presenter's state and say hello as a follower (`v=`). */
  view: string | null;
  /** Public state key (`p=`): a follower takes only state signed with its private half (decision 73). */
  verify?: string | null;
  /** Private state key: only the presenter holds it, to sign its state. */
  sign?: string | null;
}
