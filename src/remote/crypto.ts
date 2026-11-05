import * as v from "valibot";
import type { EncryptedFrame, RemoteMessage, RoomCredentials } from "./types";

/**
 * End-to-end encryption for remote control (decision 8). The room key lives
 * only in the join link's fragment, so the relay sees ciphertext and nothing
 * else. Everything that comes back from the relay is hostile until it both
 * decrypts under the room key and validates (decision 46): a frame that
 * fails either check is dropped, never reported to the sender.
 *
 * This file uses no DOM types, so the Node-run unit tests can import it.
 */

const IV_BYTES = 12;
const KEY_BYTES = 32;
const ROOM_BYTES = 16;
const ID_BYTES = 9;

// Ceilings for what a peer may send. They only stop a hostile key holder
// from making every screen render an unbounded payload; the relay's 16 KB
// frame cap (API_LIMITS.maxFrameBytes) bounds the whole message anyway.
export const MAX_ADDRESS_CHARS = 2048;
export const MAX_TITLE_CHARS = 1000;
const MAX_SLIDES = 10_000;
const MAX_LINK_CHARS = 16 * 1024;

const BASE64URL = /^[A-Za-z0-9_-]*$/;

/** An imported room key. Spelled this way because Node's types declare `CryptoKey` as a value only. */
export type RoomKey = Parameters<typeof crypto.subtle.encrypt>[1];

export function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/** Null for anything that is not unpadded base64url. */
export function fromBase64Url(text: string): Uint8Array<ArrayBuffer> | null {
  if (!BASE64URL.test(text) || text.length % 4 === 1) return null;
  const binary = atob(text.replaceAll("-", "+").replaceAll("_", "/"));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function randomBytes(length: number): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(length));
}

/** A fresh room: 16 random bytes of id (22 chars) and a 256-bit AES-GCM key (43 chars). */
export function createRoomCredentials(): RoomCredentials {
  return { room: toBase64Url(randomBytes(ROOM_BYTES)), key: toBase64Url(randomBytes(KEY_BYTES)) };
}

/** A random participant id for `hello`, 12 base64url characters. */
export function randomId(): string {
  return toBase64Url(randomBytes(ID_BYTES));
}

const RoomId = v.pipe(v.string(), v.regex(BASE64URL), v.minLength(22), v.maxLength(64));
// 32 bytes are exactly 43 unpadded base64url characters.
const RawKey = v.pipe(v.string(), v.regex(BASE64URL), v.length(43));

/** Room credentials as they arrive from a URL fragment or from storage. */
export const RoomCredentialsSchema = v.object({ room: RoomId, key: RawKey });

/** Imports the raw room key; rejects a key that is not exactly 256 bits. */
export async function importKey(key: string): Promise<RoomKey> {
  const raw = fromBase64Url(key);
  if (!raw || raw.length !== KEY_BYTES) throw new Error("A room key is 32 bytes of base64url.");
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

const Address = v.pipe(v.string(), v.minLength(1), v.maxLength(MAX_ADDRESS_CHARS));
const Count = v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(MAX_SLIDES));
const Unit = v.pipe(v.number(), v.finite(), v.minValue(0), v.maxValue(1));

/** A follower may open this link, so only http(s) passes; the follower also checks the origin. */
const DocLink = v.pipe(
  v.string(),
  v.maxLength(MAX_LINK_CHARS),
  v.check((text) => {
    try {
      const { protocol } = new URL(text);
      return protocol === "https:" || protocol === "http:";
    } catch {
      return false;
    }
  }, "docLink must be an http(s) URL"),
);

const Depth = v.picklist([1, 2, 3, 4, 5, 6]);

/** A slide level as the URL writes it: "auto", one depth, or two or more distinct depths in order. */
const Level = v.union([
  v.literal("auto"),
  Depth,
  v.pipe(
    v.array(Depth),
    v.minLength(2),
    v.maxLength(6),
    v.check((list) => list.every((d, i) => i === 0 || d > list[i - 1]!), "levels must ascend"),
  ),
]);

const StateMessage = v.pipe(
  v.object({
    type: v.literal("state"),
    current: Address,
    index: Count,
    total: Count,
    title: v.pipe(v.string(), v.maxLength(MAX_TITLE_CHARS)),
    docLink: v.nullable(DocLink),
    // Defaults keep a page from before these fields (a cached install) in step.
    docLinkTooLong: v.optional(v.boolean(), false),
    level: v.optional(Level, "auto"),
  }),
  v.check((m) => m.index < m.total, "index must be inside the deck"),
);

/** Every plaintext a peer may send; unknown fields are stripped, unknown types fail. */
export const RemoteMessageSchema = v.variant("type", [
  StateMessage,
  v.object({ type: v.literal("step"), direction: v.picklist([1, -1]) }),
  v.object({ type: v.literal("goto"), address: Address }),
  v.object({ type: v.literal("laser"), x: Unit, y: Unit }),
  v.object({ type: v.literal("laser-off") }),
  v.object({
    type: v.literal("hello"),
    role: v.picklist(["remote", "follower"]),
    id: v.pipe(v.string(), v.regex(BASE64URL), v.minLength(8), v.maxLength(64)),
  }),
]) satisfies v.GenericSchema<unknown, RemoteMessage>;

const FrameSchema = v.object({
  v: v.literal(1),
  // A 12-byte IV is 16 base64url characters.
  iv: v.pipe(v.string(), v.length(16)),
  data: v.pipe(v.string(), v.minLength(1)),
});

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

/** Encrypts one message with a fresh random 96-bit IV; an IV is never reused under a key. */
export async function encrypt(key: RoomKey, message: RemoteMessage): Promise<EncryptedFrame> {
  const iv = randomBytes(IV_BYTES);
  const plaintext = encoder.encode(JSON.stringify(message));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext);
  return { v: 1, iv: toBase64Url(iv), data: toBase64Url(new Uint8Array(ciphertext)) };
}

/**
 * The message inside `frame`, or null when the frame is malformed, was
 * encrypted under another key, was altered in transit, or carries a
 * plaintext that is not a valid `RemoteMessage`.
 */
export async function decrypt(key: RoomKey, frame: unknown): Promise<RemoteMessage | null> {
  const parsedFrame = v.safeParse(FrameSchema, frame);
  if (!parsedFrame.success) return null;
  const iv = fromBase64Url(parsedFrame.output.iv);
  const data = fromBase64Url(parsedFrame.output.data);
  if (!iv || iv.length !== IV_BYTES || !data) return null;
  let json: unknown;
  try {
    const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, data);
    json = JSON.parse(decoder.decode(plaintext));
  } catch {
    return null;
  }
  const message = v.safeParse(RemoteMessageSchema, json);
  return message.success ? message.output : null;
}

/** Room credentials from a join link's fragment (`#room=<id>&k=<key>`), or null. */
export function parseJoinFragment(hash: string): RoomCredentials | null {
  const params = new URLSearchParams(hash.startsWith("#") ? hash.slice(1) : hash);
  const parsed = v.safeParse(RoomCredentialsSchema, {
    room: params.get("room"),
    key: params.get("k"),
  });
  return parsed.success ? parsed.output : null;
}

/**
 * The join link for `view`: the app at `base`'s path with `?view=<view>` and
 * the credentials in the fragment, which browsers never send to a server.
 * Other query parameters and fragments of `base` are dropped: a follower gets
 * the document from the presenter's `state`, not from this link.
 */
export function formatJoinUrl(
  base: string,
  view: "remote" | "follow",
  creds: RoomCredentials,
): string {
  const url = new URL(base);
  url.search = new URLSearchParams({ view }).toString();
  url.hash = new URLSearchParams({ room: creds.room, k: creds.key }).toString();
  return url.href;
}
