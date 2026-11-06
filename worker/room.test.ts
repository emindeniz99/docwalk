import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { API_LIMITS } from "../src/api/types";
import {
  createRoomCredentials,
  encrypt,
  importKey,
  randomId,
  toBase64Url,
} from "../src/remote/crypto";
import type { EncryptedFrame } from "../src/remote/types";
import { CONTROL_SEATS, isRelayable } from "./room";

let roomCounter = 0;
/** A fresh room per test: rooms are Durable Objects that outlive a test. */
function newRoom(): string {
  roomCounter += 1;
  return `room-test-${String(roomCounter).padStart(12, "0")}`;
}

async function join(
  room: string,
  seat: string | null = null,
): Promise<{ status: number; socket: WebSocket | null }> {
  const query = seat === null ? "" : `?seat=${seat}`;
  const response = await SELF.fetch(`https://docwalk.test/api/remote/${room}${query}`, {
    headers: { Upgrade: "websocket" },
  });
  const socket = response.webSocket;
  if (socket) socket.accept();
  else await response.body?.cancel();
  return { status: response.status, socket };
}

async function joinOk(room: string, seat: string | null = null): Promise<WebSocket> {
  const { status, socket } = await join(room, seat);
  expect(status).toBe(101);
  if (!socket) throw new Error("no socket");
  return socket;
}

/** Collects every text frame a socket receives. */
function inbox(socket: WebSocket): string[] {
  const received: string[] = [];
  socket.addEventListener("message", (event) => {
    received.push(typeof event.data === "string" ? event.data : "<binary>");
  });
  return received;
}

async function waitFor(check: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function frame(data: string): string {
  const value: EncryptedFrame = { v: 2, iv: "AAAAAAAAAAAAAAAA", data };
  return JSON.stringify(value);
}

describe("RemoteRoom relay", () => {
  it("relays the frames real clients encrypt", async () => {
    // The relay checks the envelope's version; when the clients bumped it and
    // the relay did not, every frame was dropped while client tests stayed green.
    const key = await importKey(createRoomCredentials().key);
    const sealed = await encrypt(
      key,
      { type: "step", direction: 1 },
      { sender: randomId(), counter: 0 },
    );
    expect(isRelayable(JSON.stringify(sealed))).toBe(true);
  });

  it("forwards a frame to every other socket unchanged and not back to the sender", async () => {
    const room = newRoom();
    const presenter = await joinOk(room);
    const phone = await joinOk(room);
    const follower = await joinOk(room);
    const [toPresenter, toPhone, toFollower] = [inbox(presenter), inbox(phone), inbox(follower)];

    const sent = frame("c3RlcA");
    phone.send(sent);
    await waitFor(() => toPresenter.length === 1 && toFollower.length === 1);
    // Byte-for-byte: the relay never parses into a new shape or re-serialises.
    expect(toPresenter).toEqual([sent]);
    expect(toFollower).toEqual([sent]);
    expect(toPhone).toEqual([]);
  });

  it("keeps rooms apart, so one deck's remote cannot drive another", async () => {
    const roomA = newRoom();
    const a1 = await joinOk(roomA);
    const a2 = await joinOk(roomA);
    const b1 = await joinOk(newRoom());
    const [toA2, toB1] = [inbox(a2), inbox(b1)];
    a1.send(frame("aGVsbG8"));
    await waitFor(() => toA2.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(toB1).toEqual([]);
  });

  it("drops oversized, non-JSON, binary and wrongly shaped frames; later valid frames still pass", async () => {
    const room = newRoom();
    const sender = await joinOk(room);
    const receiver = await joinOk(room);
    const received = inbox(receiver);

    const oversized = frame("A".repeat(API_LIMITS.maxFrameBytes));
    for (const bad of [
      oversized,
      "not json",
      JSON.stringify({ type: "step", direction: 1 }), // plaintext RemoteMessage, not encrypted
      JSON.stringify({ v: 1, iv: "AAAA", data: "AAAA" }), // the old frame version
      JSON.stringify({ v: 3, iv: "AAAA", data: "AAAA" }),
      JSON.stringify({ v: 2, iv: "AAAA", data: "AAAA", note: "smuggled plaintext" }),
      JSON.stringify({ v: 2, iv: "AA==", data: "AAAA" }),
    ]) {
      sender.send(bad);
    }
    sender.send(new Uint8Array([1, 2, 3]));
    // Frames from one socket are handled in order, so the marker arriving first proves the rest were dropped.
    const marker = frame("bWFya2Vy");
    sender.send(marker);
    await waitFor(() => received.length >= 1);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(received).toEqual([marker]);
  });

  it(`refuses socket ${API_LIMITS.maxSocketsPerRoom + 1}, capping what one leaked room id can cost`, async () => {
    const room = newRoom();
    const seat = controlSeat();
    const sockets: WebSocket[] = [];
    for (let i = 0; i < API_LIMITS.maxSocketsPerRoom; i += 1) {
      sockets.push(await joinOk(room, i < CONTROL_SEATS ? seat : null));
    }
    for (const extra of [await join(room), await join(room, seat)]) {
      expect(extra.status).toBe(429);
      expect(extra.socket).toBeNull();
    }
    for (const socket of sockets) socket.close(1000, "done");
  });
});

/**
 * A seat token as a control-key holder sends it: 32 bytes of base64url. The
 * relay only compares tokens, so how clients derive one from the key
 * (`seatToken` in src/remote/client.ts, tested there) does not matter here.
 */
function controlSeat(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

describe("control seats (review pass 2)", () => {
  // The follow link is posted to an audience and carries the room id. Before,
  // anyone with it could hold all 50 sockets (or 49 real followers could),
  // and a presenter tab or phone remote that dropped and reconnected got
  // room_full: remote control and following stopped for the rest of the talk.
  // Seats are now reserved for whoever proves the control key, which a
  // follow link does not carry; the relay still never sees a key.
  const followerSeats = API_LIMITS.maxSocketsPerRoom - CONTROL_SEATS;

  it("followers fill at most the follower seats, and a reconnecting presenter still gets in", async () => {
    const room = newRoom();
    const seat = controlSeat();
    const presenter = await joinOk(room, seat);
    const followers: WebSocket[] = [];
    for (let i = 0; i < followerSeats; i += 1) followers.push(await joinOk(room));
    expect((await join(room)).status).toBe(429);

    // A network blip: the presenter's socket goes, the followers stay.
    presenter.close(1000, "blip");
    const back = await joinOk(room, seat);
    // And it still reaches the followers.
    const toFollower = inbox(followers[0]!);
    back.send(frame("c3RhdGU"));
    await waitFor(() => toFollower.length === 1);
    for (const socket of [back, ...followers]) socket.close(1000, "done");
  });

  it("a made-up seat token counts as a follower", async () => {
    const room = newRoom();
    const seat = controlSeat();
    const presenter = await joinOk(room, seat);
    // The shape of a real token, but not this room's.
    const forged = controlSeat();
    const followers: WebSocket[] = [];
    for (let i = 0; i < followerSeats; i += 1) followers.push(await joinOk(room, forged));
    expect((await join(room, forged)).status).toBe(429);
    expect((await join(room, "not-a-token")).status).toBe(429);
    const phone = await joinOk(room, seat);
    for (const socket of [presenter, phone, ...followers]) socket.close(1000, "done");
  });

  it("the first control-key holder fixes the room's seat; a later different one cannot replace it", async () => {
    const room = newRoom();
    const seat = controlSeat();
    const phone = await joinOk(room, seat);
    phone.close(1000, "gone");
    // Even with the room empty again, another token is not the room's seat.
    const other = controlSeat();
    const followers: WebSocket[] = [];
    for (let i = 0; i < followerSeats; i += 1) followers.push(await joinOk(room));
    expect((await join(room, other)).status).toBe(429);
    const presenter = await joinOk(room, seat);
    for (const socket of [presenter, ...followers]) socket.close(1000, "done");
  });
});
