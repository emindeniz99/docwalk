/**
 * Remote control and followers (decision 8, moved into v1 on 2026-11-05).
 *
 * A presenter opens a room; phones join as remotes, other devices as
 * followers, by QR code or link: `<origin>/?view=remote#room=<id>&k=<key>` or
 * `?view=follow#room=<id>&k=<key>`. The key never reaches the server: it lives
 * in the URL fragment. Every frame on the wire is an `EncryptedFrame`; the
 * relay (worker/) only forwards bytes. The document itself is never sent:
 * followers load it from the share link (`?src=`, `?repo=` or `#doc=`), which
 * the presenter includes in its `hello`.
 */

/** Plaintext messages, encrypted before sending. */
export type RemoteMessage =
  /** Presenter -> all: where the deck is. Sent on join and on every change. */
  | {
      type: "state";
      current: string;
      index: number;
      total: number;
      title: string;
      /** Share link a follower opens to load the same document. */
      docLink: string | null;
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
  | { type: "hello"; role: "remote" | "follower"; id: string };

/** What travels over the WebSocket: AES-GCM ciphertext and its IV, base64url. */
export interface EncryptedFrame {
  v: 1;
  iv: string;
  data: string;
}

/** Parsed from the join URL fragment. */
export interface RoomCredentials {
  room: string;
  /** Raw 256-bit AES-GCM key, base64url. */
  key: string;
}
