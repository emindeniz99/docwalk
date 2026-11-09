import { describe, expect, test } from "vitest";
import { MirrorFeed } from "../annotate/mirrorFeed";
import {
  MAX_STROKE_POINTS,
  mirrorFrameBytes,
  RESYNC_BYTES_PER_SECOND,
  RESYNC_MIN_GAP_MS,
  resyncGapMs,
  type MarkStroke,
  type MirrorOp,
} from "../annotate/mirrorTypes";
import { API_LIMITS } from "../api/types";
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
  { type: "countdown", countdown: { targetMs: 20 * 60_000, spentMs: 90_500, running: true } },
  { type: "countdown", countdown: { targetMs: 60_000, spentMs: 0, running: false } },
  {
    type: "countdown",
    countdown: { targetMs: 600 * 60_000, spentMs: 7 * 24 * 60 * 60_000, running: true },
  },
  { type: "countdown", countdown: null },
  { type: "mirror", op: "laser", x: 0.25, y: 0.75 },
  { type: "mirror", op: "laser-off" },
  {
    type: "mirror",
    op: "stroke",
    slide: "retries/2",
    id: 7,
    tool: "pen",
    color: "primary",
    from: 0,
    points: [0, 0, 2048, 1024, 4096, 4096],
    end: false,
  },
  { type: "mirror", op: "drop", slide: "retries/2", ids: [7, 8] },
  { type: "mirror", op: "clear", slide: "retries/2" },
  { type: "mirror", op: "keep", slide: "retries/2", ids: [7, 8] },
  { type: "mirror", op: "keep", slide: "retries/2", ids: [] },
  { type: "mirror", op: "focus-open", slide: "retries/2", diagram: 2 },
  { type: "mirror", op: "focus-view", scale: 2.5, x: -0.25, y: 0.1 },
  { type: "mirror", op: "focus-close" },
  // The code, table and image views (decision 106).
  { type: "mirror", op: "focus-open", slide: "retries/2", code: 1 },
  { type: "mirror", op: "focus-open", slide: "retries/2", table: 1000 },
  { type: "mirror", op: "focus-open", slide: "retries/2", image: 3 },
  { type: "mirror", op: "focus-lines", lines: [1, 4, 100_000] },
  { type: "mirror", op: "focus-lines", lines: [] },
  // The diagram tour (decision 109).
  { type: "mirror", op: "focus-tour", path: [1, 2, 2, 1000] },
  { type: "mirror", op: "focus-tour", path: [] },
  // Shapes and the whiteboard (decision 110).
  {
    type: "mirror",
    op: "stroke",
    slide: "retries/board",
    id: 8,
    tool: "rect",
    color: "ink",
    from: 0,
    points: [0, 10, 4096, 4000],
    end: true,
  },
  {
    type: "mirror",
    op: "stroke",
    slide: "retries/board",
    id: 9,
    tool: "ellipse",
    color: "focus",
    from: 0,
    points: [100, 200, 300, 400],
    end: true,
  },
  { type: "mirror", op: "board-open", slide: "retries/2" },
  { type: "mirror", op: "board-close" },
];

/** A seal for tests: any sender id, any counter. */
const SEAL = { sender: "SenderSender", counter: 1 };

/** `message` inside a valid seal, as JSON text: a key holder's plaintext. */
const sealed = (message: unknown) =>
  JSON.stringify({ s: SEAL.sender, n: SEAL.counter, m: message });

/** `count` pen strokes of `points` points at the widest numbers, ids from `from`. */
const widestStrokes = (count: number, points: number, from = 1): MarkStroke[] =>
  Array.from({ length: count }, (_, i) => ({
    id: from + i,
    tool: "pen",
    color: "primary",
    points: Array.from({ length: 2 * points }, () => 4096),
  }));

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

describe("the countdown message (decision 112)", () => {
  const MIN = 60_000;
  const good = { targetMs: 20 * MIN, spentMs: 5 * MIN, running: true };

  test("passes within 80's limits and as null, and strips what it does not know", async () => {
    const key = await importKey(createRoomCredentials().key);
    const open = async (countdown: unknown, extra: object = {}) =>
      (
        await decrypt(
          key,
          await encryptRaw(key, sealed({ type: "countdown", countdown, ...extra })),
        )
      )?.message;
    expect(await open(good)).toEqual({ type: "countdown", countdown: good });
    expect(await open(null)).toEqual({ type: "countdown", countdown: null });
    expect(await open({ ...good, note: "<img onerror=x>" }, { html: "x" })).toEqual({
      type: "countdown",
      countdown: good,
    });
  });

  test("a target under 1 or over 600 minutes, or a fraction of a millisecond, is dropped", async () => {
    const key = await importKey(createRoomCredentials().key);
    for (const targetMs of [0, -MIN, MIN - 1, 600 * MIN + 1, 1.5 * MIN + 0.5, null, "60000"]) {
      const frame = await encryptRaw(
        key,
        sealed({ type: "countdown", countdown: { ...good, targetMs } }),
      );
      expect([targetMs, await decrypt(key, frame)]).toEqual([targetMs, null]);
    }
  });

  test("time spent below zero, fractional, over 7 days or not a number is dropped", async () => {
    const key = await importKey(createRoomCredentials().key);
    for (const spentMs of [-1, 0.5, 7 * 24 * 60 * MIN + 1, "0", null]) {
      const frame = await encryptRaw(
        key,
        sealed({ type: "countdown", countdown: { ...good, spentMs } }),
      );
      expect([spentMs, await decrypt(key, frame)]).toEqual([spentMs, null]);
    }
  });

  test("a missing or non-boolean running flag, a missing field or a wrong shape is dropped", async () => {
    const key = await importKey(createRoomCredentials().key);
    const { running: _running, ...withoutRunning } = good;
    for (const countdown of [
      withoutRunning,
      { ...good, running: 1 },
      { ...good, running: "true" },
      { targetMs: good.targetMs, running: true },
      { spentMs: 0, running: true },
      [],
      "20:00",
      7,
      undefined,
    ]) {
      const frame = await encryptRaw(key, sealed({ type: "countdown", countdown }));
      expect([countdown, await decrypt(key, frame)]).toEqual([countdown, null]);
    }
  });

  test("it carries durations only: an instant a peer adds is stripped", async () => {
    const key = await importKey(createRoomCredentials().key);
    const frame = await encryptRaw(
      key,
      sealed({ type: "countdown", countdown: { ...good, startedAt: 1_700_000_000_000 } }),
    );
    expect((await decrypt(key, frame))?.message).toEqual({ type: "countdown", countdown: good });
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

describe("mirror messages (decision 88)", () => {
  // The presenter's laser, marks and focus view go to every follower. Every
  // follower holds the view key, so only the presenter's signature makes a
  // mirror message true, and the schema keeps even a signed one small.
  const STROKE = MESSAGES.find((m) => m.type === "mirror" && m.op === "stroke")!;

  test("a mirror message the presenter signed verifies, and every op keeps its shape", async () => {
    const { view, signer, verifier } = await signedRoom();
    for (const message of MESSAGES.filter((m) => m.type === "mirror")) {
      const opened = await decrypt(view, await encrypt(view, message, SEAL, signer), verifier);
      expect(opened?.signed).toBe(true);
      expect(opened?.message).toEqual(message);
    }
  });

  test("an unsigned mirror message, one signed by another key or for another room, does not verify", async () => {
    const { creds, view, signer, verifier } = await signedRoom();
    const forger = await signedRoom();
    const forged = [
      await encrypt(view, STROKE, SEAL),
      await encrypt(view, STROKE, SEAL, forger.signer),
      await encrypt(view, STROKE, SEAL, { ...signer, room: forger.creds.room }),
    ];
    for (const frame of forged) expect((await decrypt(view, frame, verifier))?.signed).toBe(false);
    expect(creds.room).not.toBe(forger.creds.room);
  });

  test("an edited signed mirror message, or one re-sealed under a new counter, fails the check", async () => {
    const { view, signer, verifier } = await signedRoom();
    const frame = await encrypt(view, STROKE, SEAL, signer);
    const plain = JSON.parse(
      new TextDecoder().decode(
        await crypto.subtle.decrypt(
          { name: "AES-GCM", iv: fromBase64Url(frame.iv)! },
          view,
          fromBase64Url(frame.data)!,
        ),
      ),
    ) as { s: string; n: number; m: Record<string, unknown>; g: string };
    const resealed = await encryptRaw(view, JSON.stringify({ ...plain, n: plain.n + 1 }));
    expect((await decrypt(view, resealed, verifier))?.signed).toBe(false);
    const moved = await encryptRaw(
      view,
      JSON.stringify({ ...plain, m: { ...plain.m, points: [1, 1, 2, 2] } }),
    );
    expect((await decrypt(view, moved, verifier))?.signed).toBe(false);
  });

  test("values outside the ranges the receiver draws are dropped even from a key holder", async () => {
    const key = await importKey(createRoomCredentials().key);
    const stroke = {
      type: "mirror",
      op: "stroke",
      slide: "a/1",
      id: 1,
      tool: "pen",
      color: "primary",
      from: 0,
      points: [1, 2, 3, 4],
      end: false,
    };
    const hostile: unknown[] = [
      { type: "mirror", op: "laser", x: 1.5, y: 0.5 },
      { type: "mirror", op: "laser", x: 0.5, y: Number.NaN },
      { type: "mirror", op: "launch" },
      { type: "mirror", op: "laser-off", extra: "<img onerror=x>" },
      { ...stroke, points: [1, 2, 3] },
      { ...stroke, points: [0, 4097] },
      { ...stroke, points: [0, -1] },
      { ...stroke, points: [0.5, 1] },
      { ...stroke, points: Array.from({ length: 258 }, () => 1) },
      { ...stroke, from: 3 },
      { ...stroke, from: 3000 },
      { ...stroke, from: 2990, points: Array.from({ length: 20 }, () => 1) },
      { ...stroke, id: -1 },
      { ...stroke, id: 2 ** 31 },
      { ...stroke, tool: "rectangle" },
      // A shape is two corners sent whole; a hostile sender cannot grow or cut it (decision 110).
      { ...stroke, tool: "rect", points: [1, 2], end: true },
      { ...stroke, tool: "rect", points: [1, 2, 3, 4], end: false },
      { ...stroke, tool: "ellipse", points: [1, 2, 3, 4, 5, 6], end: true },
      { ...stroke, tool: "ellipse", from: 4, points: [1, 2], end: true },
      { ...stroke, tool: "arrow", points: [1, 2, 3, 4, 5, 6], end: true },
      { ...stroke, tool: "arrow", points: [1, 2, 3, 4], end: false },
      { type: "mirror", op: "board-open" },
      { type: "mirror", op: "board-open", slide: "" },
      { type: "mirror", op: "board-open", slide: "x".repeat(2049) },
      { type: "mirror", op: "board-open", slide: "a/1", title: "<b>" },
      { type: "mirror", op: "board-close", slide: "a/1" },
      { type: "mirror", op: "board", slide: "a/1" },
      { ...stroke, color: "#ff0000" },
      { ...stroke, color: "url(javascript:x)" },
      { ...stroke, slide: "" },
      { ...stroke, slide: "x".repeat(2049) },
      { ...stroke, html: "<script>" },
      { type: "mirror", op: "drop", slide: "a/1", ids: Array.from({ length: 65 }, (_, i) => i) },
      { type: "mirror", op: "drop", slide: "a/1", ids: [1.5] },
      { type: "mirror", op: "clear" },
      { type: "mirror", op: "focus-open", slide: "a/1", diagram: 0 },
      { type: "mirror", op: "focus-open", slide: "a/1", diagram: 1001 },
      { type: "mirror", op: "focus-view", scale: 20, x: 0, y: 0 },
      { type: "mirror", op: "focus-view", scale: 0, x: 0, y: 0 },
      { type: "mirror", op: "focus-view", scale: 1, x: 9, y: 0 },
      // keep (decision 103): a slide and at most 200 whole, bounded ids, nothing else.
      { type: "mirror", op: "keep", slide: "a/1", ids: Array.from({ length: 201 }, (_, i) => i) },
      { type: "mirror", op: "keep", slide: "a/1", ids: [1.5] },
      { type: "mirror", op: "keep", slide: "a/1", ids: [-1] },
      { type: "mirror", op: "keep", slide: "a/1", ids: [2 ** 31] },
      { type: "mirror", op: "keep", slide: "a/1", ids: [Number.NaN] },
      { type: "mirror", op: "keep", slide: "a/1", ids: ["1"] },
      { type: "mirror", op: "keep", slide: "a/1", ids: "1,2" },
      { type: "mirror", op: "keep", slide: "a/1" },
      { type: "mirror", op: "keep", ids: [1] },
      { type: "mirror", op: "keep", slide: "", ids: [1] },
      { type: "mirror", op: "keep", slide: "x".repeat(2049), ids: [1] },
      { type: "mirror", op: "keep", slide: "a/1", ids: [1], html: "<img onerror=x>" },
    ];
    for (const message of hostile) {
      expect(await decrypt(key, await encryptRaw(key, sealed(message)))).toBeNull();
    }
  });

  test("a focus op names a block by one kind and its place, and marked lines stay few, whole and in order (decision 106)", async () => {
    const key = await importKey(createRoomCredentials().key);
    const open = { type: "mirror", op: "focus-open", slide: "a/1" };
    const lines = { type: "mirror", op: "focus-lines" };
    const hostile: unknown[] = [
      // One kind and one place from 1 to 1000; no text, no id, no second kind.
      { ...open, code: 0 },
      { ...open, table: 1001 },
      { ...open, image: 1.5 },
      { ...open, code: -1 },
      { ...open, code: Number.POSITIVE_INFINITY },
      { ...open, code: "1" },
      { ...open, image: "#figure-1" },
      { ...open, code: 1, table: 1 },
      { ...open, diagram: 1, image: 1 },
      { ...open, video: 1 },
      { ...open },
      { type: "mirror", op: "focus-open", code: 1 },
      { ...open, slide: "", code: 1 },
      { ...open, slide: "x".repeat(2049), table: 1 },
      { ...open, code: 1, text: "const a = 1;" },
      { ...open, image: 1, src: "https://images.invalid/a.png" },
      // Line numbers from 1, ascending, at most 256 of them, none past 100,000.
      { ...lines, lines: Array.from({ length: 257 }, (_, i) => i + 1) },
      { ...lines, lines: [0] },
      { ...lines, lines: [100_001] },
      { ...lines, lines: [3, 2] },
      { ...lines, lines: [2, 2] },
      { ...lines, lines: [1.5] },
      { ...lines, lines: [Number.NaN] },
      { ...lines, lines: ["1"] },
      { ...lines, lines: "1,2" },
      { ...lines, lines: null },
      lines,
      { ...lines, lines: [1], slide: "a/1" },
      { ...lines, lines: [1], html: "<mark>" },
    ];
    for (const message of hostile) {
      expect(
        await decrypt(key, await encryptRaw(key, sealed(message))),
        `${JSON.stringify(message)}`,
      ).toBeNull();
    }
  });

  test("a tour path is at most 64 whole node numbers from 1 to 1000 and nothing else (decision 109)", async () => {
    const key = await importKey(createRoomCredentials().key);
    const tour = { type: "mirror", op: "focus-tour" };
    const hostile: unknown[] = [
      { ...tour, path: Array.from({ length: 65 }, (_, i) => i + 1) },
      { ...tour, path: [0] },
      { ...tour, path: [-1] },
      { ...tour, path: [1001] },
      { ...tour, path: [2.5] },
      { ...tour, path: [Number.NaN] },
      { ...tour, path: [Number.POSITIVE_INFINITY] },
      { ...tour, path: [1, "2"] },
      { ...tour, path: ["node-a"] },
      { ...tour, path: [null] },
      { ...tour, path: "1,2" },
      { ...tour, path: 1 },
      { ...tour, path: null },
      tour,
      { ...tour, path: [1], slide: "a/1" },
      { ...tour, path: [1], ids: ["a"] },
      { ...tour, path: [1], html: "<b>" },
      { type: "mirror", op: "focus-tours", path: [1] },
      { type: "mirror", op: "tour", path: [1] },
    ];
    for (const message of hostile) {
      expect(
        await decrypt(key, await encryptRaw(key, sealed(message))),
        `${JSON.stringify(message)}`,
      ).toBeNull();
    }
    // The longest valid path and the shortest are fine.
    for (const path of [[], [1], Array.from({ length: 64 }, (_, i) => 937 + i)]) {
      const opened = await decrypt(key, await encryptRaw(key, sealed({ ...tour, path })));
      expect(opened?.message, `${path.length} entries`).toEqual({ ...tour, path });
    }
  });

  test("the longest tour path fits a relay frame and arrives intact, and the host's estimate holds (decision 109)", async () => {
    // Like every mirror op it cannot be split into parts: 64 of the widest
    // node numbers must fit one 16 KB frame, signed.
    const { view, signer, verifier } = await signedRoom();
    const widest: RemoteMessage = {
      type: "mirror",
      op: "focus-tour",
      path: Array.from({ length: 64 }, (_, i) => 937 + i),
    };
    const frame = await encrypt(view, widest, SEAL, signer);
    const bytes = JSON.stringify(frame).length;
    expect(bytes).toBeLessThan(1024);
    expect(bytes).toBeLessThanOrEqual(API_LIMITS.maxFrameBytes);
    const opened = await decrypt(view, frame, verifier);
    expect(opened?.signed).toBe(true);
    expect(opened?.message).toEqual(widest);
    const { type: _type, ...op } = widest as { type: "mirror" } & MirrorOp;
    const estimate = mirrorFrameBytes(op as MirrorOp);
    expect(estimate, "the estimate never undercounts").toBeGreaterThanOrEqual(bytes);
    expect(estimate, "and stays close").toBeLessThan(bytes * 1.02);
    console.info(
      `mirror focus-tour: 64 nodes, ${JSON.stringify(widest).length} bytes of JSON, ${bytes} as a frame`,
    );
  });

  test("the longest list of marked lines fits a relay frame and arrives intact (decision 106)", async () => {
    // Like every mirror op it cannot be split into parts, so 256 of the
    // widest line numbers must fit one 16 KB frame, signed.
    const { view, signer, verifier } = await signedRoom();
    const widest: RemoteMessage = {
      type: "mirror",
      op: "focus-lines",
      lines: Array.from({ length: 256 }, (_, i) => 100_000 - 255 + i),
    };
    const frame = await encrypt(view, widest, SEAL, signer);
    const bytes = JSON.stringify(frame).length;
    expect(bytes).toBeLessThan(3 * 1024);
    expect(bytes).toBeLessThanOrEqual(API_LIMITS.maxFrameBytes);
    const opened = await decrypt(view, frame, verifier);
    expect(opened?.signed).toBe(true);
    expect(opened?.message).toEqual(widest);
    console.info(
      `mirror focus-lines: 256 lines, ${JSON.stringify(widest).length} bytes of JSON, ${bytes} as a frame`,
    );
  });

  test("the widest board-open and the widest shape fit a relay frame, and the host's estimate holds for both (decision 110)", async () => {
    // The longest address, in characters that take three bytes each: neither
    // op can be split into parts, and the resync gap is computed from the estimate.
    const { view, signer, verifier } = await signedRoom();
    const address = "語".repeat(2048);
    const widest: RemoteMessage[] = [
      { type: "mirror", op: "board-open", slide: address },
      {
        type: "mirror",
        op: "stroke",
        slide: address,
        id: 2 ** 31 - 1,
        tool: "ellipse",
        color: "primary",
        from: 0,
        points: [4096, 4096, 4096, 4096],
        end: true,
      },
    ];
    for (const message of widest) {
      const { type: _type, ...op } = message as { type: "mirror" } & MirrorOp;
      const frame = await encrypt(view, message, SEAL, signer);
      const bytes = JSON.stringify(frame).length;
      expect(bytes).toBeLessThanOrEqual(API_LIMITS.maxFrameBytes);
      const opened = await decrypt(view, frame, verifier);
      expect(opened?.signed).toBe(true);
      expect(opened?.message).toEqual(message);
      const estimate = mirrorFrameBytes(op as MirrorOp);
      expect(estimate, `${op.op}: the estimate never undercounts`).toBeGreaterThanOrEqual(bytes);
      expect(estimate, `${op.op}: and stays close`).toBeLessThan(bytes * 1.02);
    }
  });

  test("the largest keep a presenter can send fits a relay frame and arrives intact (decision 103)", async () => {
    // A mirror message cannot be split into parts, so the widest keep must
    // fit one 16 KB frame signed: 200 of the largest ids and the longest
    // address, in characters that take three bytes each.
    const { view, signer, verifier } = await signedRoom();
    const widest: RemoteMessage = {
      type: "mirror",
      op: "keep",
      slide: "語".repeat(2048),
      ids: Array.from({ length: 200 }, (_, i) => 2 ** 31 - 1 - i),
    };
    const frame = await encrypt(view, widest, SEAL, signer);
    expect(JSON.stringify(frame).length).toBeLessThanOrEqual(API_LIMITS.maxFrameBytes);
    const opened = await decrypt(view, frame, verifier);
    expect(opened?.signed).toBe(true);
    expect(opened?.message).toEqual(widest);
  });

  test("a resync waits long enough to cost at most 64 KB/s of sealed frames, whatever the slide holds (decision 103)", async () => {
    // A follower's hello costs the presenter one resync per gap, signed and
    // sealed frame by frame. The host estimates that cost from each op's JSON
    // (mirrorFrameBytes); these are the real frames, with counters as large
    // as a week-long room reaches.
    const { view, signer } = await signedRoom();
    const shapes = {
      // The receiver's limit: 30,000 points, the widest numbers.
      full: widestStrokes(20, MAX_STROKE_POINTS),
      // 200 strokes of one segment each: the frames are mostly seal and signature.
      small: widestStrokes(200, 2),
      mixed: [...widestStrokes(180, 2), ...widestStrokes(4, MAX_STROKE_POINTS, 1000)],
    };
    const gaps: Record<string, number> = {};
    for (const [name, marks] of Object.entries(shapes)) {
      const feed = new MirrorFeed();
      feed.ingest({ kind: "marks", slide: "retries/2", strokes: marks, reset: true });
      const ops: MirrorOp[] = [];
      feed.resync((op) => ops.push(op));
      let bytes = 0;
      let estimated = 0;
      for (const [i, op] of ops.entries()) {
        const seal = { sender: SEAL.sender, counter: 10_000_000 + i };
        const frame = await encrypt(view, { type: "mirror", ...op }, seal, signer);
        bytes += JSON.stringify(frame).length;
        estimated += mirrorFrameBytes(op);
      }
      gaps[name] = resyncGapMs(estimated);
      expect(estimated, `${name}: the estimate never undercounts`).toBeGreaterThanOrEqual(bytes);
      expect(estimated, `${name}: and stays close`).toBeLessThan(bytes * 1.02);
      expect((bytes * 1000) / gaps[name]!, `${name}: bytes a second`).toBeLessThanOrEqual(
        RESYNC_BYTES_PER_SECOND,
      );
      console.info(
        `mirror resync (${name}): ${ops.length} frames, ${bytes} bytes sealed, next resync after ${gaps[name]} ms`,
      );
    }
    // The review's worst case repeats about every 8 s; a light slide keeps the 2 s floor.
    expect(gaps["full"]).toBeGreaterThan(7000);
    expect(gaps["full"]).toBeLessThan(9000);
    expect(gaps["small"]).toBe(RESYNC_MIN_GAP_MS);
  });

  test("the largest stroke chunk fits a relay frame with room to spare", async () => {
    // worker/room.ts drops anything over 16 KB; 128 points of the widest numbers is the ceiling.
    const { view, signer } = await signedRoom();
    const widest = {
      ...STROKE,
      slide: `${"s".repeat(100)}/12`,
      points: Array.from({ length: 256 }, () => 4096),
      end: true,
    } as RemoteMessage;
    const frame = await encrypt(view, widest, SEAL, signer);
    expect(JSON.stringify(frame).length).toBeLessThan(6 * 1024);
  });
});
