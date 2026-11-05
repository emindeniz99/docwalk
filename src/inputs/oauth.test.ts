import { describe, expect, test, vi } from "vitest";
import type { FetchLike } from "./load";
import {
  completeLogin,
  fetchApiHealth,
  OAUTH_PENDING_KEY,
  pkceChallenge,
  startLogin,
  type OAuthEnv,
} from "./oauth";
import { clearToken, readRefresh, readToken, storePastedToken, type StorageLike } from "./token";

class MemoryStorage implements StorageLike {
  items = new Map<string, string>();
  getItem = (key: string) => this.items.get(key) ?? null;
  setItem = (key: string, value: string) => void this.items.set(key, value);
  removeItem = (key: string) => void this.items.delete(key);
}

const ORIGIN = "https://docwalk.example";
const CLIENT_ID = "Iv23liExampleClient";
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const TOKENS = {
  access_token: "ghu_" + "a".repeat(36),
  expires_in: 28_800,
  refresh_token: "ghr_" + "r".repeat(76),
  refresh_token_expires_in: 15_897_600,
  token_type: "bearer",
};

/** A whole browser for the flow: storage, location, history, clock and timers, all observable. */
function makeEnv(respond: (url: string, init?: RequestInit) => Response = () => json(TOKENS)) {
  const timers: { callback: () => void; ms: number; cleared: boolean }[] = [];
  let now = 1_800_000_000_000;
  const env = {
    fetch: vi.fn<FetchLike>(async (url, init) => respond(url, init)),
    storage: new MemoryStorage(),
    location: {
      origin: ORIGIN,
      href: `${ORIGIN}/?repo=acme/docs&path=README.md#intro/1`,
      assign: vi.fn<(url: string) => void>(),
    },
    history: { replaceState: vi.fn<OAuthEnv["history"]["replaceState"]>() },
    now: () => now,
    setTimeout: (callback: () => void, ms: number) => {
      const timer = { callback, ms, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimeout: (handle: unknown) => {
      (handle as { cleared: boolean }).cleared = true;
    },
  } satisfies OAuthEnv;
  return { env, timers, advance: (ms: number) => (now += ms) };
}

/** Runs startLogin and returns the authorize URL GitHub would receive. */
async function begin(env: OAuthEnv) {
  return new URL(await startLogin(CLIENT_ID, env));
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const callback = (state: string, code = "abc123") =>
  `${ORIGIN}/?oauth=callback&code=${code}&state=${state}`;

const health = (response: Response | Error) =>
  fetchApiHealth(async () => {
    if (response instanceof Error) throw response;
    return response;
  });

describe("PKCE (decision 36)", () => {
  test("the S256 challenge matches RFC 7636 appendix B, so GitHub will accept the verifier", async () => {
    expect(await pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });

  test("startLogin sends S256, a fresh state and the fixed callback, and keeps the verifier local", async () => {
    const { env } = makeEnv();
    const url = await begin(env);
    expect(`${url.origin}${url.pathname}`).toBe("https://github.com/login/oauth/authorize");
    const pending = JSON.parse(env.storage.getItem(OAUTH_PENDING_KEY)!);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: CLIENT_ID,
      redirect_uri: `${ORIGIN}/?oauth=callback`,
      state: pending.state,
      code_challenge: await pkceChallenge(pending.verifier),
      code_challenge_method: "S256",
    });
    // 32 random bytes each: a guessable state or verifier defeats the point.
    expect(pending.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(pending.state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(url.href).not.toContain(pending.verifier);
    expect(env.location.assign).toHaveBeenCalledWith(url.href);
  });

  test("two logins never share a state", async () => {
    const a = await begin(makeEnv().env);
    const b = await begin(makeEnv().env);
    expect(a.searchParams.get("state")).not.toBe(b.searchParams.get("state"));
  });

  test("a malformed client id from the Worker is refused instead of put in the URL", async () => {
    await expect(startLogin("x&redirect_uri=https://evil.example", makeEnv().env)).rejects.toThrow(
      "Invalid GitHub client id",
    );
  });
});

describe("completeLogin", () => {
  test("exchanges the code with the stored verifier, stores the token and returns to the original page", async () => {
    const { env, timers } = makeEnv();
    const state = (await begin(env)).searchParams.get("state")!;
    const verifier = JSON.parse(env.storage.getItem(OAUTH_PENDING_KEY)!).verifier;

    const result = await completeLogin(callback(state), env);

    expect(result).toMatchObject({ kind: "signed-in", token: TOKENS.access_token });
    const [path, init] = env.fetch.mock.calls[0]!;
    expect(path).toBe("/api/github/token");
    expect(JSON.parse(String(init?.body))).toEqual({
      code: "abc123",
      code_verifier: verifier,
      redirect_uri: `${ORIGIN}/?oauth=callback`,
    });
    expect(readToken(env.storage)).toBe(TOKENS.access_token);
    // The code leaves the address bar, and the ?repo= link the user signed in from comes back.
    expect(env.history.replaceState).toHaveBeenCalledWith(
      null,
      "",
      "/?repo=acme/docs&path=README.md#intro/1",
    );
    // Refresh five minutes before the 8 h token expires.
    expect(timers).toHaveLength(1);
    expect(timers[0]!.ms).toBe(TOKENS.expires_in * 1000 - 5 * 60_000);
  });

  test("a state that does not match is rejected and the code is never sent", async () => {
    const { env } = makeEnv();
    await begin(env);
    const result = await completeLogin(callback("A".repeat(43)), env);
    expect(result).toMatchObject({ kind: "error" });
    expect(env.fetch).not.toHaveBeenCalled();
    expect(readToken(env.storage)).toBeNull();
    // Even a rejected callback must not leave its code in history.
    const cleaned = env.history.replaceState.mock.calls[0]![2];
    expect(cleaned).not.toContain("code=");
  });

  test("a callback replayed after a successful sign-in is rejected: a state is single-use", async () => {
    const { env } = makeEnv();
    const state = (await begin(env)).searchParams.get("state")!;
    await completeLogin(callback(state), env);
    const replay = await completeLogin(callback(state, "other"), env);
    expect(replay).toMatchObject({ kind: "error" });
    expect(env.fetch).toHaveBeenCalledTimes(1);
  });

  test("a sign-in left for more than ten minutes is not resumed", async () => {
    const { env, advance } = makeEnv();
    const state = (await begin(env)).searchParams.get("state")!;
    advance(11 * 60_000);
    expect(await completeLogin(callback(state), env)).toMatchObject({ kind: "error" });
    expect(env.fetch).not.toHaveBeenCalled();
  });

  test("a callback with no sign-in started in this tab is rejected", async () => {
    const { env } = makeEnv();
    expect(await completeLogin(callback("B".repeat(43)), env)).toMatchObject({ kind: "error" });
    expect(env.fetch).not.toHaveBeenCalled();
    expect(env.history.replaceState).toHaveBeenCalledWith(null, "", "/");
  });

  test("the user cancelling on GitHub reads as cancelled", async () => {
    const { env } = makeEnv();
    await begin(env);
    const result = await completeLogin(`${ORIGIN}/?oauth=callback&error=access_denied`, env);
    expect(result).toEqual({ kind: "error", message: "GitHub sign-in was cancelled." });
  });

  test("any other URL is left alone", async () => {
    const { env } = makeEnv();
    expect(await completeLogin(`${ORIGIN}/?src=x&code=1`, env)).toEqual({ kind: "none" });
    expect(env.history.replaceState).not.toHaveBeenCalled();
  });

  test("a malformed token response stores nothing", async () => {
    const { env } = makeEnv(() => json({ ...TOKENS, access_token: "<img onerror=x>" }));
    const state = (await begin(env)).searchParams.get("state")!;
    expect(await completeLogin(callback(state), env)).toMatchObject({ kind: "error" });
    expect(readToken(env.storage)).toBeNull();
    expect(readRefresh(env.storage)).toBeNull();
  });

  test("the scheduled refresh swaps in a new token, and a rejected refresh signs out", async () => {
    let refreshStatus = 200;
    const next = { ...TOKENS, access_token: "ghu_" + "n".repeat(36) };
    const { env, timers } = makeEnv((url) =>
      url === "/api/github/refresh"
        ? json(refreshStatus === 200 ? next : { error: "bad" }, refreshStatus)
        : json(TOKENS),
    );
    const state = (await begin(env)).searchParams.get("state")!;
    const signedOut = vi.fn<() => void>();
    await completeLogin(callback(state), env, signedOut);

    timers[0]!.callback();
    await flush();
    const [, init] = env.fetch.mock.calls[1]!;
    expect(JSON.parse(String(init?.body))).toEqual({ refresh_token: TOKENS.refresh_token });
    expect(readToken(env.storage)).toBe(next.access_token);
    expect(timers).toHaveLength(2);

    refreshStatus = 401;
    timers[1]!.callback();
    await flush();
    expect(readToken(env.storage)).toBeNull();
    expect(signedOut).toHaveBeenCalledTimes(1);
  });

  test("an offline token exchange is reported, not thrown, so the app's start-up still loads the document", async () => {
    const { env } = makeEnv(() => {
      throw new TypeError("Failed to fetch");
    });
    const state = (await begin(env)).searchParams.get("state")!;
    await expect(completeLogin(callback(state), env)).resolves.toMatchObject({ kind: "error" });
    expect(readToken(env.storage)).toBeNull();
  });

  test("a Worker outage during refresh keeps the user signed in and retries a minute later", async () => {
    let refreshStatus = 503;
    const { env, timers } = makeEnv((url) =>
      url === "/api/github/refresh" && refreshStatus !== 200
        ? json({ error: "down" }, refreshStatus)
        : json(TOKENS),
    );
    const state = (await begin(env)).searchParams.get("state")!;
    const signedOut = vi.fn<() => void>();
    await completeLogin(callback(state), env, signedOut);

    timers[0]!.callback();
    await flush();
    // A 5xx says nothing about the refresh token; wiping it would sign out everyone on a blip.
    expect(readToken(env.storage)).toBe(TOKENS.access_token);
    expect(readRefresh(env.storage)?.refreshToken).toBe(TOKENS.refresh_token);
    expect(signedOut).not.toHaveBeenCalled();
    expect(timers[1]!.ms).toBe(60_000);

    refreshStatus = 200;
    timers[1]!.callback();
    await flush();
    expect(readToken(env.storage)).toBe(TOKENS.access_token);
    expect(timers).toHaveLength(3);
  });

  test("a refresh timer left over from OAuth leaves a token the user pasted afterwards alone", async () => {
    const { env, timers } = makeEnv((url) =>
      url === "/api/github/refresh" ? json({ error: "bad" }, 401) : json(TOKENS),
    );
    const state = (await begin(env)).searchParams.get("state")!;
    const signedOut = vi.fn<() => void>();
    await completeLogin(callback(state), env, signedOut);

    const pasted = "github_pat_" + "P".repeat(40);
    expect(storePastedToken(pasted, env.storage)).toBe(true);
    timers[0]!.callback();
    await flush();
    // Without this, a rejected refresh would delete the pasted token and announce a sign-out.
    expect(readToken(env.storage)).toBe(pasted);
    expect(env.fetch).toHaveBeenCalledTimes(1);
    expect(signedOut).not.toHaveBeenCalled();
  });

  test("after Forget token the leftover timer does not announce a second sign-out", async () => {
    const { env, timers } = makeEnv();
    const state = (await begin(env)).searchParams.get("state")!;
    const signedOut = vi.fn<() => void>();
    await completeLogin(callback(state), env, signedOut);
    clearToken(env.storage);
    timers[0]!.callback();
    await flush();
    expect(signedOut).not.toHaveBeenCalled();
    expect(env.fetch).toHaveBeenCalledTimes(1);
  });

  test("a page address too long to store still returns the user to the page, without its fragment", async () => {
    const { env } = makeEnv();
    env.location.href = `${ORIGIN}/?repo=acme/docs&path=README.md#doc=${"x".repeat(70_000)}`;
    const state = (await begin(env)).searchParams.get("state")!;
    expect(await completeLogin(callback(state), env)).toMatchObject({ kind: "signed-in" });
    expect(env.history.replaceState).toHaveBeenCalledWith(
      null,
      "",
      "/?repo=acme/docs&path=README.md",
    );
  });

  test("stopRefresh cancels the pending timer", async () => {
    const { env, timers } = makeEnv();
    const state = (await begin(env)).searchParams.get("state")!;
    const result = await completeLogin(callback(state), env);
    if (result.kind !== "signed-in") throw new Error("expected sign-in");
    result.stopRefresh();
    expect(timers[0]!.cleared).toBe(true);
  });
});

describe("fetchApiHealth: static mode hides every /api feature", () => {
  test("a Worker's answer lists its features and client id", async () => {
    expect(
      await health(json({ ok: true, features: ["oauth", "remote"], githubClientId: CLIENT_ID })),
    ).toEqual({ ok: true, features: ["oauth", "remote"], githubClientId: CLIENT_ID });
  });

  test("a static host's SPA fallback (index.html with 200) is static mode, not a crash", async () => {
    const html = new Response("<!doctype html><title>docwalk</title>", {
      headers: { "content-type": "text/html" },
    });
    expect(await health(html)).toBeNull();
  });

  test("404, a network error or a wrong shape is static mode", async () => {
    expect(await health(new Response("", { status: 404 }))).toBeNull();
    expect(await health(new TypeError("Failed to fetch"))).toBeNull();
    expect(await health(json({ ok: "yes", features: [] }))).toBeNull();
  });

  test("oauth without a usable client id is not offered, and unknown features are ignored", async () => {
    expect(await health(json({ ok: true, features: ["oauth", "remote", "future"] }))).toEqual({
      ok: true,
      features: ["remote"],
    });
    expect(await health(json({ ok: true, features: ["oauth"], githubClientId: "a b&c" }))).toEqual({
      ok: true,
      features: [],
    });
  });
});
