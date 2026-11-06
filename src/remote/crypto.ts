import * as v from "valibot";
import { MAX_DOCUMENT_BYTES } from "../inputs/types";
import type { EncryptedFrame, RemoteMessage, RoomCredentials } from "./types";

/**
 * End-to-end encryption for remote control (decision 8). The room keys live
 * only in the join links' fragments, so the relay sees ciphertext and nothing
 * else. Everything that comes back from the relay is hostile until it both
 * decrypts under a room key and validates (decision 46): a frame that fails
 * either check is dropped, never reported to the sender.
 *
 * A room has two keys (decision 68): the control key (`k=`, the phone remote
 * link, agents) and the view key (`v=`, the follow link). client.ts decides
 * what each key may carry. Every plaintext also carries its sender's random
 * session id and a counter, so a receiver can drop a replayed frame.
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
export const MAX_NOTE_CHARS = 1000;
export const MAX_AGENT_NAME_CHARS = 64;

/**
 * Parts (parts.ts): a message larger than a relay frame is deflated and cut
 * into pieces of at most PART_BYTES. 8 KB of payload is 10,924 base64url
 * characters; inside an encrypted frame that stays under the 16 KB cap, which
 * a test checks. MAX_PARTS bounds a transfer at 4 MB compressed.
 */
export const PART_BYTES = 8 * 1024;
export const MAX_PARTS = 512;
/**
 * Largest message a set of parts may inflate to: a full document, JSON-escaped
 * (a control character becomes six characters), plus the envelope.
 */
export const MAX_ASSEMBLED_BYTES = 6 * MAX_DOCUMENT_BYTES + 64 * 1024;

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

/**
 * A fresh room: 16 random bytes of id (22 chars) and two independent 256-bit
 * AES-GCM keys (43 chars each), control and view. Independent, so the view
 * key reveals nothing about the control key.
 */
export function createRoomCredentials(): RoomCredentials & { key: string; view: string } {
  return {
    room: toBase64Url(randomBytes(ROOM_BYTES)),
    key: toBase64Url(randomBytes(KEY_BYTES)),
    view: toBase64Url(randomBytes(KEY_BYTES)),
  };
}

/** A random participant id for `hello`, 12 base64url characters. */
export function randomId(): string {
  return toBase64Url(randomBytes(ID_BYTES));
}

const RoomId = v.pipe(v.string(), v.regex(BASE64URL), v.minLength(22), v.maxLength(64));
// 32 bytes are exactly 43 unpadded base64url characters.
const RawKey = v.pipe(v.string(), v.regex(BASE64URL), v.length(43));

/** The presenter's room as it comes back from storage: both keys. */
export const RoomCredentialsSchema = v.object({ room: RoomId, key: RawKey, view: RawKey });

/** A join link's fragment: the room and at least one key. */
const JoinFragmentSchema = v.pipe(
  v.object({ room: RoomId, key: v.nullable(RawKey), view: v.nullable(RawKey) }),
  v.check((c) => c.key !== null || c.view !== null, "a join link carries a key"),
);

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

/** A participant, request or transfer id: random base64url (randomId), or "presenter". */
const Id = v.pipe(v.string(), v.regex(BASE64URL), v.minLength(8), v.maxLength(64));
/** A revision is 16 bytes of SHA-256, base64url (agent.ts). */
const Revision = v.pipe(v.string(), v.regex(BASE64URL), v.length(22));
/** Measured in UTF-8 bytes, like every other way a document gets in (inputs/types.ts). */
const Markdown = v.pipe(
  v.string(),
  v.maxLength(MAX_DOCUMENT_BYTES),
  v.check((text) => encoder.encode(text).byteLength <= MAX_DOCUMENT_BYTES, "document too large"),
);
/** Shown to the presenter as plain text; control characters could fake a line break. */
const AgentName = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(MAX_AGENT_NAME_CHARS),
  v.regex(/^[^\p{Cc}]+$/u),
);
const AgentSlideSchema = v.object({
  address: Address,
  title: v.pipe(v.string(), v.maxLength(MAX_TITLE_CHARS)),
  note: v.nullable(v.pipe(v.string(), v.maxLength(MAX_NOTE_CHARS))),
});

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
    role: v.picklist(["remote", "follower", "agent"]),
    id: Id,
  }),
  v.object({ type: v.literal("doc-get"), request: Id, from: Id }),
  v.object({ type: v.literal("doc"), request: Id, to: Id, markdown: Markdown, revision: Revision }),
  v.object({
    type: v.literal("doc-write"),
    request: Id,
    from: Id,
    name: AgentName,
    markdown: Markdown,
    base: v.nullable(Revision),
  }),
  v.object({ type: v.literal("slides-get"), request: Id, from: Id }),
  v.object({
    type: v.literal("slides"),
    request: Id,
    to: Id,
    current: v.nullable(Address),
    slides: v.pipe(v.array(AgentSlideSchema), v.maxLength(MAX_SLIDES)),
  }),
  v.variant("ok", [
    v.object({
      type: v.literal("result"),
      request: Id,
      to: Id,
      ok: v.literal(true),
      revision: Revision,
    }),
    v.object({
      type: v.literal("result"),
      request: Id,
      to: Id,
      ok: v.literal(false),
      error: v.picklist(["edits-off", "conflict", "no-document", "too-large"]),
    }),
  ]),
  v.pipe(
    v.object({
      type: v.literal("part"),
      to: Id,
      id: Id,
      seq: v.pipe(v.number(), v.integer(), v.minValue(0)),
      total: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(MAX_PARTS)),
      data: v.pipe(
        v.string(),
        v.regex(BASE64URL),
        v.minLength(1),
        v.maxLength(Math.ceil((PART_BYTES * 4) / 3)),
      ),
    }),
    v.check((m) => m.seq < m.total, "seq must be inside the transfer"),
  ),
]) satisfies v.GenericSchema<unknown, RemoteMessage>;

const FrameSchema = v.object({
  // 2: the plaintext is a sealed message ({ s, n, m }) under a control or view key.
  v: v.literal(2),
  // A 12-byte IV is 16 base64url characters.
  iv: v.pipe(v.string(), v.length(16)),
  data: v.pipe(v.string(), v.minLength(1)),
});

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

/**
 * Who sent a frame and in what order: a random id per connection (randomId)
 * and a counter that only goes up. Both sit inside the ciphertext, so the
 * relay can neither read nor change them; a receiver drops a counter it has
 * already seen from that sender (replay.ts).
 */
export interface Seal {
  sender: string;
  counter: number;
}

export interface Sealed extends Seal {
  message: RemoteMessage;
}

const SealSchema = v.object({
  s: Id,
  n: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(Number.MAX_SAFE_INTEGER)),
  m: v.unknown(),
});

/** Encrypts one message with its seal and a fresh random 96-bit IV; an IV is never reused under a key. */
export async function encrypt(
  key: RoomKey,
  message: RemoteMessage,
  { sender, counter }: Seal,
): Promise<EncryptedFrame> {
  const iv = randomBytes(IV_BYTES);
  const plaintext = encoder.encode(JSON.stringify({ s: sender, n: counter, m: message }));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext);
  return { v: 2, iv: toBase64Url(iv), data: toBase64Url(new Uint8Array(ciphertext)) };
}

/**
 * The sealed message inside `frame`, or null when the frame is malformed,
 * was encrypted under another key, was altered in transit, or carries a
 * plaintext that is not a valid seal around a valid `RemoteMessage`.
 */
export async function decrypt(key: RoomKey, frame: unknown): Promise<Sealed | null> {
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
  const seal = v.safeParse(SealSchema, json);
  if (!seal.success) return null;
  const message = v.safeParse(RemoteMessageSchema, seal.output.m);
  if (!message.success) return null;
  return { sender: seal.output.s, counter: seal.output.n, message: message.output };
}

/**
 * Room credentials from a join link's fragment, or null: `#room=<id>&k=<key>`
 * (phone remote, agents) or `#room=<id>&v=<key>` (follow along). A key that
 * is absent is null.
 */
export function parseJoinFragment(hash: string): RoomCredentials | null {
  const params = new URLSearchParams(hash.startsWith("#") ? hash.slice(1) : hash);
  const parsed = v.safeParse(JoinFragmentSchema, {
    room: params.get("room"),
    key: params.get("k"),
    view: params.get("v"),
  });
  return parsed.success ? parsed.output : null;
}

/**
 * The join link for `view`: the app at `base`'s path with `?view=<view>` and
 * the room and one key in the fragment, which browsers never send to a
 * server. A remote link carries only the control key, a follow link only the
 * view key, so a follow link handed to an audience cannot steer the deck or
 * read the document (decision 68). Other query parameters and fragments of
 * `base` are dropped: a follower gets the document from the presenter's
 * `state`, not from this link.
 */
export function formatJoinUrl(
  base: string,
  view: "remote" | "follow",
  creds: RoomCredentials,
): string {
  const key = view === "remote" ? creds.key : creds.view;
  if (key === null) throw new Error(`These credentials have no key for a ${view} link.`);
  const url = new URL(base);
  url.search = new URLSearchParams({ view }).toString();
  url.hash = new URLSearchParams({
    room: creds.room,
    [view === "remote" ? "k" : "v"]: key,
  }).toString();
  return url.href;
}
