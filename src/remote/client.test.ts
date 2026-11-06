import { describe, expect, test } from "vitest";
import { connectRoom, type RemoteRole, type SocketFactory, seatToken } from "./client";
import { createPresenterCredentials, createRoomCredentials } from "./crypto";

/**
 * Control seats (worker/room.ts): the relay keeps some sockets for whoever
 * proves the control key, so followers cannot lock the presenter and its
 * phone remotes out of their own room. The proof is a token derived from
 * the control key; a follow link, which carries only the view key, has none.
 */

/** The seat each role's socket is opened with. */
async function seatOf(role: RemoteRole, creds = createRoomCredentials()) {
  const roleCreds = role === "follower" ? { ...creds, key: null } : creds;
  const seats: (string | null | undefined)[] = [];
  const factory: SocketFactory = (_url, _handlers, seat) => {
    seats.push(seat);
    return { send() {}, close() {} };
  };
  const conn = connectRoom({
    creds: roleCreds,
    role,
    onMessage() {},
    onStatus() {},
    socketFactory: factory,
    base: "https://docwalk.example/",
  });
  await expect.poll(() => seats.length).toBe(1);
  conn.close();
  return seats[0];
}

describe("control seat token", () => {
  test("presenter, phone remote and agent sockets carry the control key's seat token", async () => {
    const creds = createRoomCredentials();
    const expected = await seatToken(creds);
    for (const role of ["presenter", "remote", "agent"] as const) {
      expect(await seatOf(role, creds)).toBe(expected);
    }
  });

  test("a follower's socket carries none, so it never takes a control seat", async () => {
    expect(await seatOf("follower", await createPresenterCredentials())).toBeNull();
  });

  test("the token is the shape the relay accepts: 43 base64url characters", async () => {
    // worker/room.ts SeatTokenSchema; any other shape seats the socket as a follower.
    expect(await seatToken(createRoomCredentials())).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  test("it depends on the control key and the room, not on the view key", async () => {
    const creds = createRoomCredentials();
    const other = createRoomCredentials();
    const token = await seatToken(creds);
    expect(await seatToken({ ...creds, view: other.view })).toBe(token);
    expect(await seatToken({ ...creds, key: other.key })).not.toBe(token);
    expect(await seatToken({ ...creds, room: other.room })).not.toBe(token);
    expect(await seatToken({ ...creds, key: null })).toBeNull();
  });
});
