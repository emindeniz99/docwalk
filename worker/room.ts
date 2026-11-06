/**
 * One remote-control room (decision 8): a Durable Object that relays
 * end-to-end encrypted frames between the presenter, remotes and followers.
 * It never decrypts, never stores a message and keeps no state besides the
 * sockets themselves, which the WebSocket Hibernation API holds while the
 * object sleeps between slide changes.
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

export class RemoteRoom extends DurableObject<Env> {
  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return jsonError("websocket_required", 426);
    }
    if (this.ctx.getWebSockets().length >= API_LIMITS.maxSocketsPerRoom) {
      return jsonError("room_full", 429);
    }
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
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
