import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  clearToken,
  parseToken,
  readRefresh,
  readToken,
  REFRESH_STORAGE_KEY,
  storeRefresh,
  storePastedToken,
  storeToken,
  type StorageLike,
} from "./token";
import { TOKEN_STORAGE_KEY } from "./types";

class MemoryStorage implements StorageLike {
  items = new Map<string, string>();
  getItem = (key: string) => this.items.get(key) ?? null;
  setItem = (key: string, value: string) => void this.items.set(key, value);
  removeItem = (key: string) => void this.items.delete(key);
  dump = () => JSON.stringify([...this.items]);
}

const TOKEN = "github_pat_" + "Z9".repeat(20);

let session: MemoryStorage;
let local: MemoryStorage;

beforeEach(() => {
  session = new MemoryStorage();
  local = new MemoryStorage();
  // The default path: the module must pick sessionStorage on its own.
  vi.stubGlobal("sessionStorage", session);
  vi.stubGlobal("localStorage", local);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("token storage (decision 35)", () => {
  test("a saved token lands in sessionStorage and never in localStorage, so it dies with the tab", () => {
    expect(storeToken(TOKEN)).toBe(true);
    expect(session.getItem(TOKEN_STORAGE_KEY)).toBe(TOKEN);
    expect(readToken()).toBe(TOKEN);
    expect(local.items.size).toBe(0);
    expect(local.dump()).not.toContain(TOKEN);
  });

  test("the token is never written to the console", () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => {}),
    );
    storeToken(TOKEN);
    readToken();
    storeToken("not a token");
    clearToken();
    for (const spy of spies) {
      expect(JSON.stringify(spy.mock.calls)).not.toContain(TOKEN);
    }
  });

  test("a paste with surrounding whitespace is trimmed; anything else is refused before storage", () => {
    expect(parseToken(`  ${TOKEN}\n`)).toBe(TOKEN);
    for (const bad of [
      "",
      "short_1",
      `${TOKEN} extra`,
      `${TOKEN}\r\nX-Header: 1`,
      "ghp_ä".repeat(10),
    ]) {
      expect(parseToken(bad)).toBeNull();
      expect(storeToken(bad)).toBe(false);
    }
    expect(session.items.size).toBe(0);
  });

  test("a tampered stored value is not handed out as a token", () => {
    session.setItem(TOKEN_STORAGE_KEY, "<script>");
    expect(readToken()).toBeNull();
  });

  test("Forget token removes the access token and the OAuth refresh state", () => {
    storeToken(TOKEN);
    storeRefresh({ refreshToken: "ghr_" + "a".repeat(40), expiresAt: 1, refreshExpiresAt: 2 });
    clearToken();
    expect(session.items.size).toBe(0);
    expect(readRefresh()).toBeNull();
  });

  test("a pasted token drops leftover OAuth refresh state, so no later refresh can replace it", () => {
    storeRefresh({ refreshToken: "ghr_" + "a".repeat(40), expiresAt: 1, refreshExpiresAt: 2 });
    expect(storePastedToken(` ${TOKEN} `)).toBe(true);
    expect(readToken()).toBe(TOKEN);
    expect(readRefresh()).toBeNull();
    // A bad paste changes nothing, including the refresh state of a working sign-in.
    storeRefresh({ refreshToken: "ghr_" + "a".repeat(40), expiresAt: 1, refreshExpiresAt: 2 });
    expect(storePastedToken("not a token")).toBe(false);
    expect(readRefresh()).not.toBeNull();
    expect(local.items.size).toBe(0);
  });

  test("storage that throws (privacy mode) means no token, not a crash", () => {
    const broken: StorageLike = {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
      removeItem: () => {
        throw new Error("SecurityError");
      },
    };
    expect(storeToken(TOKEN, broken)).toBe(false);
    expect(readToken(broken)).toBeNull();
    expect(() => clearToken(broken)).not.toThrow();
  });

  test("refresh state round-trips and malformed JSON reads as none", () => {
    const record = { refreshToken: "ghr_" + "b".repeat(40), expiresAt: 10, refreshExpiresAt: 20 };
    expect(storeRefresh(record)).toBe(true);
    expect(readRefresh()).toEqual(record);
    session.setItem(REFRESH_STORAGE_KEY, "{not json");
    expect(readRefresh()).toBeNull();
    expect(local.items.size).toBe(0);
  });
});
