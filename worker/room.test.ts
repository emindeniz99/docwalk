import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { API_LIMITS } from "../src/api/types";
import type { EncryptedFrame } from "../src/remote/types";

let roomCounter = 0;
/** A fresh room per test: rooms are Durable Objects that outlive a test. */
function newRoom(): string {
  roomCounter += 1;
  return `room-test-${String(roomCounter).padStart(12, "0")}`;
}

async function join(room: string): Promise<{ status: number; socket: WebSocket | null }> {
  const response = await SELF.fetch(`https://docwalk.test/api/remote/${room}`, {
    headers: { Upgrade: "websocket" },
  });
  const socket = response.webSocket;
  if (socket) socket.accept();
  else await response.body?.cancel();
  return { status: response.status, socket };
}

async function joinOk(room: string): Promise<WebSocket> {
  const { status, socket } = await join(room);
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
  const value: EncryptedFrame = { v: 1, iv: "AAAAAAAAAAAAAAAA", data };
  return JSON.stringify(value);
}

describe("RemoteRoom relay", () => {
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
      JSON.stringify({ v: 2, iv: "AAAA", data: "AAAA" }),
      JSON.stringify({ v: 1, iv: "AAAA", data: "AAAA", note: "smuggled plaintext" }),
      JSON.stringify({ v: 1, iv: "AA==", data: "AAAA" }),
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
    const sockets: WebSocket[] = [];
    for (let i = 0; i < API_LIMITS.maxSocketsPerRoom; i += 1) sockets.push(await joinOk(room));
    const extra = await join(room);
    expect(extra.status).toBe(429);
    expect(extra.socket).toBeNull();
    for (const socket of sockets) socket.close(1000, "done");
  });
});
