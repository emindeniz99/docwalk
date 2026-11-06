/**
 * One remote-control room (decision 8): a Durable Object that relays
 * end-to-end encrypted frames between the presenter, remotes and followers.
 * It never decrypts and never stores a message. Its only state besides the
 * sockets (which the WebSocket Hibernation API holds while the object sleeps
 * between slide changes) is the SHA-256 of the room's control seat token,
 * removed a week after it was set once the room is empty.
 */
import { DurableObject } from "cloudflare:workers";
import * as v from "valibot";
import { API_LIMITS } from "../src/api/types";
import type { EncryptedFrame } from "../src/remote/types";
import type { Env } from "./env";

const Base64Url = v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]+$/));

/**
 * Only the ciphertext envelope passes; extra fields could smuggle plaintext.
 * `v` must match the clients' frame version (src/remote/types.ts), or the
 * relay drops every frame while the clients' own tests stay green.
 */
const EncryptedFrameSchema = v.strictObject({
  v: v.literal(2),
  iv: v.pipe(Base64Url, v.maxLength(64)),
  data: Base64Url,
}) satisfies v.GenericSchema<unknown, EncryptedFrame>;

const encoder = new TextEncoder();

/** True when `message` is a text frame within the size cap shaped like an `EncryptedFrame`. */
export function isRelayable(message: string | ArrayBuffer): message is string {
  if (typeof message !== "string") return false;
  // A UTF-16 length over the cap is over it in UTF-8 too; skip encoding huge frames.
  if (message.length > API_LIMITS.maxFrameBytes) return false;
  if (encoder.encode(message).byteLength > API_LIMITS.maxFrameBytes) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(message);
  } catch {
    return false;
  }
  return v.safeParse(EncryptedFrameSchema, parsed).success;
}

function jsonError(error: string, status: number): Response {
  return Response.json({ error }, { status });
}

/**
 * Seats only a control-key holder (presenter, phone remotes, agents) can
 * take, so followers, whether many real ones or one person opening sockets
 * from a follow link, can never lock the presenter out of its own room.
 * Followers get the other `maxSocketsPerRoom - CONTROL_SEATS`.
 */
export const CONTROL_SEATS = 10;
/** How long the seat commitment outlives its setting while the room is empty. Rooms last a presenter's tab session. */
const SEAT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SEAT_KEY = "seat";
/** An HMAC-SHA-256 in unpadded base64url (src/remote/client.ts `seatToken`). */
const SeatTokenSchema = v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{43}$/));

interface SocketSeat {
  control: boolean;
}

async function sha256(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(text)));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

function isControl(socket: WebSocket): boolean {
  return (socket.deserializeAttachment() as SocketSeat | null)?.control === true;
}

export class RemoteRoom extends DurableObject<Env> {
  /**
   * The relay stays blind: it cannot check a key, so a control-key holder
   * proves the key with a token derived from it (`?seat=`), and the room
   * keeps the hash of the first token it sees. Rooms are random ids created
   * in the presenter's tab, which connects before anyone has its links, so
   * the first token is the presenter's (or a phone's: the same key, the same
   * token). A token that does not match, or none, is a follower's.
   */
  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return jsonError("websocket_required", 426);
    }
    const token = new URL(request.url).searchParams.get("seat");
    const hash = v.is(SeatTokenSchema, token) ? await sha256(token) : null;
    // From this read to the accept nothing awaits, so no other upgrade interleaves.
    let commit = await this.ctx.storage.get<string>(SEAT_KEY);
    if (hash !== null && commit === undefined) {
      commit = hash;
      void this.ctx.storage.put(SEAT_KEY, hash);
      void this.ctx.storage.setAlarm(Date.now() + SEAT_TTL_MS);
    }
    const control = hash !== null && hash === commit;
    const sockets = this.ctx.getWebSockets();
    const followers = sockets.filter((socket) => !isControl(socket)).length;
    if (
      sockets.length >= API_LIMITS.maxSocketsPerRoom ||
      (!control && followers >= API_LIMITS.maxSocketsPerRoom - CONTROL_SEATS)
    ) {
      return jsonError("room_full", 429);
    }
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ control } satisfies SocketSeat);
    return new Response(null, { status: 101, webSocket: client });
  }

  /** Forgets the seat once the room is empty; a room still in use keeps it another week. */
  override async alarm(): Promise<void> {
    if (this.ctx.getWebSockets().length > 0) {
      await this.ctx.storage.setAlarm(Date.now() + SEAT_TTL_MS);
    } else {
      await this.ctx.storage.deleteAll();
    }
  }

  override webSocketMessage(sender: WebSocket, message: string | ArrayBuffer): void {
    // Dropped silently: answering would tell a prober what the relay accepts.
    if (!isRelayable(message)) return;
    for (const peer of this.ctx.getWebSockets()) {
      if (peer === sender) continue;
      try {
        peer.send(message);
      } catch {
        // A peer that is closing misses the frame; the presenter resends state on hello.
      }
    }
  }

  override webSocketClose(socket: WebSocket): void {
    try {
      socket.close(1000, "closed");
    } catch {
      // Already closed (auto-reply to close is on for this compatibility date).
    }
  }
}
