import { describe, expect, test } from "vitest";
import {
  createPresenterCredentials,
  createRoomCredentials,
  decrypt,
  encrypt,
  formatJoinUrl,
  fromBase64Url,
  importKey,
  importSigningKey,
  importVerifyKey,
  parseJoinFragment,
  randomId,
  type RoomKey,
  toBase64Url,
} from "./crypto";
import type { EncryptedFrame, RemoteMessage } from "./types";

const MESSAGES: RemoteMessage[] = [
  {
    type: "state",
    current: "retries/2",
    index: 21,
    total: 47,
    title: "Retries",
    docLink: "https://docwalk.example/?src=https%3A%2F%2Fraw.githubusercontent.com%2Fa%2Fb.md",
    docLinkTooLong: false,
    level: [2, 3],
  },
  {
    type: "state",
    current: "intro/1",
    index: 0,
    total: 1,
    title: "",
    docLink: null,
    docLinkTooLong: true,
    level: "auto",
  },
  { type: "step", direction: 1 },
  { type: "step", direction: -1 },
  { type: "goto", address: "timeouts/1" },
  { type: "laser", x: 0, y: 1 },
  { type: "laser-off" },
  { type: "hello", role: "follower", id: "AbCdEfGhIjKl" },
];

/** A seal for tests: any sender id, any counter. */
const SEAL = { sender: "SenderSender", counter: 1 };

/** `message` inside a valid seal, as JSON text: a key holder's plaintext. */
const sealed = (message: unknown) =>
  JSON.stringify({ s: SEAL.sender, n: SEAL.counter, m: message });

/** Encrypts arbitrary text under `key`, as a hostile key holder could. */
async function encryptRaw(key: RoomKey, plaintext: string): Promise<EncryptedFrame> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(plaintext),
  );
  return { v: 2, iv: toBase64Url(iv), data: toBase64Url(new Uint8Array(data)) };
}

/** Flips one bit of a base64url string's decoded bytes. */
const presenterCreds = await createPresenterCredentials();

function flipBit(text: string, byte: number): string {
  const bytes = fromBase64Url(text)!;
  bytes[byte] = bytes[byte]! ^ 1;
  return toBase64Url(bytes);
}

describe("room credentials", () => {
  test("a room id is 22 base64url characters and a key 43: enough entropy that ids cannot be guessed", () => {
    const creds = createRoomCredentials();
    expect(creds.room).toMatch(/^[A-Za-z0-9_-]{22}$/);
    for (const key of [creds.key, creds.view]) {
      expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(fromBase64Url(key)).toHaveLength(32);
    }
  });

  test("the view key is a second random key, not the control key: a follow link cannot steer", () => {
    const creds = createRoomCredentials();
    expect(creds.view).not.toBe(creds.key);
  });

  test("every room is new: two presenters never share a room by accident", () => {
    const rooms = new Set(Array.from({ length: 200 }, () => createRoomCredentials().room));
    expect(rooms.size).toBe(200);
  });

  test("participant ids are random base64url, so a reconnect is recognised but devices are not", () => {
    expect(randomId()).toMatch(/^[A-Za-z0-9_-]{12}$/);
    expect(randomId()).not.toBe(randomId());
  });

  test("a key that is not 256 bits is refused instead of silently weakening the cipher", async () => {
    await expect(importKey(toBase64Url(new Uint8Array(16)))).rejects.toThrow("32 bytes");
    await expect(importKey("not base64url!")).rejects.toThrow("32 bytes");
  });
});

describe("encrypt and decrypt", () => {
  test("every message type survives the round trip unchanged", async () => {
    const key = await importKey(createRoomCredentials().key);
    for (const message of MESSAGES) {
      expect((await decrypt(key, await encrypt(key, message, SEAL)))?.message).toEqual(message);
    }
  });

  test("the sender id and counter travel inside the ciphertext, for replay protection", async () => {
    const key = await importKey(createRoomCredentials().key);
    const seal = { sender: "AbCdEfGhIjKl", counter: 41 };
    const frame = await encrypt(key, { type: "step", direction: 1 }, seal);
    expect(await decrypt(key, frame)).toEqual({
      ...seal,
      message: { type: "step", direction: 1 },
      signed: false,
    });
    expect(JSON.stringify(frame)).not.toContain(seal.sender);
  });

  test("a bare message without a seal, or with a bad one, is dropped: a replayable frame never passes", async () => {
    const key = await importKey(createRoomCredentials().key);
    const step = { type: "step", direction: 1 };
    for (const plaintext of [
      JSON.stringify(step),
      JSON.stringify({ s: "AbCdEfGhIjKl", m: step }),
      JSON.stringify({ s: "AbCdEfGhIjKl", n: -1, m: step }),
      JSON.stringify({ s: "AbCdEfGhIjKl", n: 1.5, m: step }),
      JSON.stringify({ s: "<x>", n: 1, m: step }),
    ]) {
      expect(await decrypt(key, await encryptRaw(key, plaintext))).toBeNull();
    }
  });

  test("the frame carries only ciphertext: the relay never sees an address or title", async () => {
    const key = await importKey(createRoomCredentials().key);
    const frame = await encrypt(key, MESSAGES[0]!, SEAL);
    expect(Object.keys(frame).toSorted()).toEqual(["data", "iv", "v"]);
    expect(JSON.stringify(frame)).not.toContain("retries");
    expect(JSON.stringify(frame)).not.toContain("Retries");
  });

  test("a frame under another room's key is dropped, so a stranger cannot steer the deck", async () => {
    const ours = await importKey(createRoomCredentials().key);
    const theirs = await importKey(createRoomCredentials().key);
    expect(
      await decrypt(ours, await encrypt(theirs, { type: "step", direction: 1 }, SEAL)),
    ).toBeNull();
  });

  test("a frame altered in transit is dropped: the relay cannot forge or edit navigation", async () => {
    const key = await importKey(createRoomCredentials().key);
    const frame = await encrypt(key, { type: "goto", address: "intro/1" }, SEAL);
    expect(await decrypt(key, { ...frame, data: flipBit(frame.data, 0) })).toBeNull();
    expect(await decrypt(key, { ...frame, iv: flipBit(frame.iv, 3) })).toBeNull();
    // Truncating the authentication tag is tampering too.
    expect(await decrypt(key, { ...frame, data: frame.data.slice(0, -4) })).toBeNull();
  });

  test("IVs never repeat, because a repeated AES-GCM IV under one key leaks plaintext", async () => {
    const key = await importKey(createRoomCredentials().key);
    const message: RemoteMessage = { type: "step", direction: 1 };
    const frames = await Promise.all(
      Array.from({ length: 2000 }, () => encrypt(key, message, SEAL)),
    );
    expect(new Set(frames.map((f) => f.iv)).size).toBe(frames.length);
    expect(new Set(frames.map((f) => f.data)).size).toBe(frames.length);
    expect(frames.every((f) => fromBase64Url(f.iv)?.length === 12)).toBe(true);
  });

  test("anything that is not an encrypted frame is dropped without throwing", async () => {
    const key = await importKey(createRoomCredentials().key);
    const frame = await encrypt(key, { type: "laser-off" }, SEAL);
    for (const junk of [
      null,
      "text",
      42,
      [],
      {},
      { ...frame, v: 1 },
      { ...frame, iv: "short" },
      { ...frame, data: "" },
      { ...frame, data: "not base64url!" },
    ]) {
      expect(await decrypt(key, junk)).toBeNull();
    }
  });

  test("a key holder's malformed plaintext is dropped: the key proves membership, not good intent", async () => {
    const key = await importKey(createRoomCredentials().key);
    const state = { type: "state", current: "a/1", index: 0, total: 1, title: "A", docLink: null };
    const hostile: unknown[] = [
      { type: "reload" },
      { type: "step", direction: 5 },
      { type: "step", direction: "1" },
      { type: "laser", x: 1.5, y: 0.5 },
      { type: "laser", x: -0.1, y: 0.5 },
      { type: "goto", address: "" },
      { type: "goto", address: "x".repeat(5000) },
      { type: "hello", role: "presenter", id: "AbCdEfGhIjKl" },
      { type: "hello", role: "remote", id: "<script>" },
      { ...state, index: 1 },
      { ...state, index: 0.5 },
      { ...state, title: "x".repeat(2000) },
      { ...state, docLink: "javascript:alert(1)" },
      { ...state, docLink: "data:text/html,hi" },
      { ...state, docLink: "not a url" },
      { ...state, docLinkTooLong: "yes" },
      { ...state, level: 9 },
      { ...state, level: 0 },
      { ...state, level: [] },
      { ...state, level: [3] },
      { ...state, level: [3, 2] },
      { ...state, level: [2, 2] },
      { ...state, level: "H2" },
    ];
    for (const message of hostile) {
      expect(await decrypt(key, await encryptRaw(key, sealed(message)))).toBeNull();
    }
    expect(await decrypt(key, await encryptRaw(key, "{not json"))).toBeNull();
  });

  test("a state from a page that predates the level and link-status fields reads as auto with no missing link", async () => {
    // A follower with an older cached build must still follow; the defaults
    // are what that presenter meant (it had no level override to send).
    const key = await importKey(createRoomCredentials().key);
    const old = { type: "state", current: "a/1", index: 0, total: 1, title: "A", docLink: null };
    expect((await decrypt(key, await encryptRaw(key, sealed(old))))?.message).toEqual({
      ...old,
      docLinkTooLong: false,
      level: "auto",
    });
  });

  test("unknown fields are stripped, so nothing a peer adds reaches the app", async () => {
    const key = await importKey(createRoomCredentials().key);
    const frame = await encryptRaw(
      key,
      sealed({ type: "step", direction: 1, html: "<img onerror=x>" }),
    );
    expect((await decrypt(key, frame))?.message).toEqual({ type: "step", direction: 1 });
  });
});

/** A presenter's room with its keys imported: view key, signer and the follow link's verifier. */
async function signedRoom() {
  const creds = await createPresenterCredentials();
  return {
    creds,
    view: await importKey(creds.view),
    signer: { room: creds.room, key: await importSigningKey(creds.sign) },
    verifier: { room: creds.room, key: await importVerifyKey(creds.verify) },
  };
}

describe("state signatures (decision 73)", () => {
  // Every follower holds the view key. Before signatures, any one of them
  // could seal a state whose docLink was a `#doc=` of their own and make
  // every other follower's screen load it for the rest of the talk.
  const STATE = MESSAGES[0]!;

  test("a state the presenter signed verifies under the follow link's key", async () => {
    const { view, signer, verifier } = await signedRoom();
    const opened = await decrypt(view, await encrypt(view, STATE, SEAL, signer), verifier);
    expect(opened?.signed).toBe(true);
    expect(opened?.message).toEqual(STATE);
  });

  test("an unsigned state, one signed by another key or for another room, does not", async () => {
    const { creds, view, signer, verifier } = await signedRoom();
    const forger = await signedRoom();
    const forged = [
      await encrypt(view, STATE, SEAL),
      await encrypt(view, STATE, SEAL, forger.signer),
      await encrypt(view, STATE, SEAL, { ...signer, room: forger.creds.room }),
    ];
    for (const frame of forged) expect((await decrypt(view, frame, verifier))?.signed).toBe(false);
    expect(creds.room).not.toBe(forger.creds.room);
  });

  test("a follower that re-seals the presenter's signed state under a new counter fails the check", async () => {
    // The signature covers the seal, so an old signed state cannot be sent
    // again as a fresh frame; the original frame is dropped by the replay guard.
    const { view, signer, verifier } = await signedRoom();
    const frame = await encrypt(view, STATE, SEAL, signer);
    const plain = JSON.parse(
      new TextDecoder().decode(
        await crypto.subtle.decrypt(
          { name: "AES-GCM", iv: fromBase64Url(frame.iv)! },
          view,
          fromBase64Url(frame.data)!,
        ),
      ),
    ) as { s: string; n: number; m: unknown; g: string };
    const resealed = await encryptRaw(view, JSON.stringify({ ...plain, n: plain.n + 1 }));
    expect((await decrypt(view, resealed, verifier))?.signed).toBe(false);
    const edited = await encryptRaw(
      view,
      JSON.stringify({ ...plain, m: { ...STATE, docLink: "https://docwalk.example/#doc=evil" } }),
    );
    expect((await decrypt(view, edited, verifier))?.signed).toBe(false);
  });

  test("the follow link's key is a 65-byte P-256 point; anything else is refused", async () => {
    const { creds } = await signedRoom();
    expect(fromBase64Url(creds.verify)).toHaveLength(65);
    await expect(importVerifyKey(toBase64Url(new Uint8Array(33)))).rejects.toThrow("65-byte");
  });
});

describe("join links", () => {
  const creds = presenterCreds;

  test("the credentials go in the fragment, which browsers never send to the relay or the host", () => {
    const url = new URL(formatJoinUrl("https://docwalk.example/app/", "remote", creds));
    expect(url.origin + url.pathname).toBe("https://docwalk.example/app/");
    expect(url.searchParams.get("view")).toBe("remote");
    expect(url.search).not.toContain(creds.key);
    expect(url.hash).toContain(creds.key);
  });

  test("the remote link carries only the control key and the follow link only the view key", () => {
    // The follow link goes to an audience: with the control key in it, anyone
    // there could steer the deck, read the document and, with agent edits on,
    // replace it (decision 68).
    const remote = new URL(formatJoinUrl("https://docwalk.example/", "remote", creds));
    const follow = new URL(formatJoinUrl("https://docwalk.example/", "follow", creds));
    expect(parseJoinFragment(remote.hash)).toEqual({
      room: creds.room,
      key: creds.key,
      view: null,
      verify: null,
    });
    expect(parseJoinFragment(follow.hash)).toEqual({
      room: creds.room,
      key: null,
      view: creds.view,
      verify: creds.verify,
    });
    expect(follow.href).not.toContain(creds.key);
    expect(remote.href).not.toContain(creds.view);
    // The private state key stays in the presenter's tab.
    expect(follow.href + remote.href).not.toContain(creds.sign);
  });

  test("a follow link stays short enough for a phone camera: a version 10 QR code or smaller", () => {
    // Version 10 at error correction M holds 213 bytes; the public state
    // key adds 89 characters to the follow link.
    const follow = formatJoinUrl("https://docwalk.example/", "follow", creds);
    expect(follow.length).toBeLessThanOrEqual(213);
  });

  test("a follow link cannot be made without the state key: its followers would trust nothing", () => {
    expect(() =>
      formatJoinUrl("https://docwalk.example/", "follow", createRoomCredentials()),
    ).toThrow("no key for a follow link");
  });

  test("the presenter's own query and fragment do not leak into the join link", () => {
    const url = formatJoinUrl(
      "https://docwalk.example/?src=https%3A%2F%2Fx.test%2Fa.md&level=2#doc=secret",
      "follow",
      creds,
    );
    expect(url).not.toContain("src=");
    expect(url).not.toContain("doc=secret");
    expect(new URL(url).searchParams.get("view")).toBe("follow");
  });

  test("parsing accepts the hash with or without its #", () => {
    expect(parseJoinFragment(`room=${creds.room}&k=${creds.key}`)).toEqual({
      room: creds.room,
      key: creds.key,
      view: null,
      verify: null,
    });
  });

  test("an incomplete or altered link yields no credentials instead of a broken room", () => {
    for (const hash of [
      "",
      "#",
      `#room=${creds.room}`,
      `#k=${creds.key}`,
      `#room=short&k=${creds.key}`,
      `#room=${creds.room}&k=${creds.key.slice(1)}`,
      `#room=${creds.room}&k=${creds.key.slice(0, -1)}+`,
      `#room=${creds.room.slice(0, -1)}%2F&k=${creds.key}`,
      `#room=${creds.room}&v=${creds.view.slice(1)}`,
      `#room=${creds.room}&k=${creds.key}&v=short`,
      `#room=${creds.room}&v=${creds.view}&p=${creds.verify.slice(1)}`,
    ]) {
      expect(parseJoinFragment(hash)).toBeNull();
    }
  });
});
