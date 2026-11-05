import { SELF, createExecutionContext } from "cloudflare:test";
import { env as configuredEnv } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { API_LIMITS, type HealthResponse, type TokenResponse } from "../src/api/types";
import worker, { type Env } from "./index";

const ORIGIN = "https://docwalk.test";
const CALLBACK = `${ORIGIN}/?oauth=callback`;
const CLIENT_ID = "Iv23liTestClientId01";
const CLIENT_SECRET = "test-client-secret-never-echoed-0123456789";

const assets = {
  fetch: () =>
    Promise.resolve(new Response("<!doctype html>", { headers: { "Content-Type": "text/html" } })),
} as unknown as Fetcher;

const OAUTH_ENV: Env = {
  ASSETS: assets,
  GITHUB_CLIENT_ID: CLIENT_ID,
  GITHUB_CLIENT_SECRET: CLIENT_SECRET,
  APP_ORIGIN: "",
};

/** Calls the Worker's default export with a hand-made env (no Miniflare bindings). */
function call(path: string, init: RequestInit = {}, env: Env = OAUTH_ENV): Promise<Response> {
  const request = new Request(`${ORIGIN}${path}`, init);
  return worker.fetch(request as Parameters<typeof worker.fetch>[0], env, createExecutionContext());
}

function post(path: string, body: unknown, headers: Record<string, string> = {}, env?: Env) {
  return call(
    path,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: ORIGIN, ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    },
    env,
  );
}

const VERIFIER = "v".repeat(43);
const GOOD_TOKEN_REQUEST = { code: "abc123", code_verifier: VERIFIER, redirect_uri: CALLBACK };

const GITHUB_TOKENS = {
  access_token: "ghu_" + "a".repeat(36),
  expires_in: 28_800,
  refresh_token: "ghr_" + "b".repeat(76),
  refresh_token_expires_in: 15_897_600,
  token_type: "bearer",
  scope: "",
};

function githubAnswers(body: unknown, status = 200) {
  return vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(Response.json(body, { status }) as Awaited<ReturnType<typeof fetch>>);
}

/** The form the Worker sent GitHub, from the fetch spy's first call. */
async function sentForm(spy: ReturnType<typeof githubAnswers>) {
  const [input, init] = spy.mock.calls[0] ?? [];
  const request = new Request(input as RequestInfo, init as RequestInit);
  const form = new URLSearchParams(new TextDecoder().decode(await request.arrayBuffer()));
  return { request, form };
}

const consoleMethods = ["log", "info", "warn", "error", "debug"] as const;
let consoleSpies: Array<ReturnType<typeof vi.spyOn>> = [];

beforeEach(() => {
  consoleSpies = consoleMethods.map((name) => vi.spyOn(console, name).mockImplementation(() => {}));
});

afterEach(() => {
  // Decision 36: tokens and bodies never reach a log. Nothing in the Worker logs at all.
  const logged = consoleSpies.some((spy) => spy.mock.calls.length > 0);
  vi.restoreAllMocks();
  if (logged) throw new Error("The Worker wrote to the console");
});

describe("GET /api/health", () => {
  it("offers oauth with the client id only when both GitHub secrets are set", async () => {
    const response = await call("/api/health");
    const body = (await response.json()) as HealthResponse;
    expect(body).toEqual({ ok: true, features: ["oauth"], githubClientId: CLIENT_ID });
    expect(JSON.stringify(body)).not.toContain(CLIENT_SECRET);
  });

  it("hides oauth when the secret is missing, so the app never shows a sign-in that cannot finish", async () => {
    const response = await call("/api/health", {}, { ASSETS: assets, GITHUB_CLIENT_ID: CLIENT_ID });
    expect(await response.json()).toEqual({ ok: true, features: [] });
  });

  it("offers remote when the deployed config has the ROOMS binding and no secrets", async () => {
    // SELF runs wrangler.jsonc as deployed: ROOMS bound, secrets not set.
    const response = await SELF.fetch(`${ORIGIN}/api/health`);
    expect(await response.json()).toEqual({ ok: true, features: ["remote"] });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("offers both when secrets and ROOMS are present", async () => {
    const rooms = (configuredEnv as Env).ROOMS;
    expect(rooms).toBeDefined();
    const response = await call(
      "/api/health",
      {},
      { ...OAUTH_ENV, ...(rooms ? { ROOMS: rooms } : {}) },
    );
    const body = (await response.json()) as HealthResponse;
    expect(body.features).toEqual(["oauth", "remote"]);
  });
});

describe("POST /api/github/token", () => {
  it("forwards code, verifier, redirect and the client credentials to GitHub as a form", async () => {
    const spy = githubAnswers(GITHUB_TOKENS);
    const response = await post("/api/github/token", GOOD_TOKEN_REQUEST);
    expect(response.status).toBe(200);

    expect(spy).toHaveBeenCalledTimes(1);
    const { request, form } = await sentForm(spy);
    expect(request.url).toBe("https://github.com/login/oauth/access_token");
    expect(request.method).toBe("POST");
    expect(request.headers.get("Accept")).toBe("application/json");
    expect(request.headers.get("Content-Type")).toContain("application/x-www-form-urlencoded");
    expect(Object.fromEntries(form)).toEqual({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      code: "abc123",
      code_verifier: VERIFIER,
      redirect_uri: CALLBACK,
    });
  });

  it("returns only the TokenResponse fields and never the client secret", async () => {
    githubAnswers({ ...GITHUB_TOKENS, token_type: "Bearer", extra: "dropped" });
    const response = await post("/api/github/token", GOOD_TOKEN_REQUEST);
    const text = await response.text();
    expect(text).not.toContain(CLIENT_SECRET);
    const expected: TokenResponse = {
      access_token: GITHUB_TOKENS.access_token,
      expires_in: GITHUB_TOKENS.expires_in,
      refresh_token: GITHUB_TOKENS.refresh_token,
      refresh_token_expires_in: GITHUB_TOKENS.refresh_token_expires_in,
      token_type: "bearer",
    };
    expect(JSON.parse(text)).toEqual(expected);
    // A token response must not sit in a shared or browser cache.
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("rejects a redirect_uri other than this origin's callback, so a code minted for another app is not redeemed", async () => {
    const spy = githubAnswers(GITHUB_TOKENS);
    for (const redirect_uri of [
      "https://evil.example/?oauth=callback",
      `${ORIGIN}/?oauth=callback&x=1`,
      `${ORIGIN}/other?oauth=callback`,
    ]) {
      const response = await post("/api/github/token", { ...GOOD_TOKEN_REQUEST, redirect_uri });
      expect({ redirect_uri, status: response.status }).toEqual({ redirect_uri, status: 400 });
      expect(await response.json()).toEqual({ error: "invalid_redirect_uri" });
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it("checks redirect_uri and Origin against APP_ORIGIN when it is set", async () => {
    const spy = githubAnswers(GITHUB_TOKENS);
    const env = { ...OAUTH_ENV, APP_ORIGIN: "https://docs.example" };
    const own = await post("/api/github/token", GOOD_TOKEN_REQUEST, {}, env);
    expect(own.status).toBe(403);
    const pinned = await post(
      "/api/github/token",
      { ...GOOD_TOKEN_REQUEST, redirect_uri: "https://docs.example/?oauth=callback" },
      { Origin: "https://docs.example" },
      env,
    );
    expect(pinned.status).toBe(200);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("rejects a foreign or missing Origin before reading the body", async () => {
    const spy = githubAnswers(GITHUB_TOKENS);
    const foreign = await post("/api/github/token", GOOD_TOKEN_REQUEST, {
      Origin: "https://evil.example",
    });
    expect(foreign.status).toBe(403);
    expect(foreign.headers.get("Access-Control-Allow-Origin")).toBeNull();
    const missing = await call("/api/github/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(GOOD_TOKEN_REQUEST),
    });
    expect(missing.status).toBe(403);
    expect(spy).not.toHaveBeenCalled();
  });

  it("rejects a non-JSON body type, which an HTML form could send cross-site without a preflight", async () => {
    const spy = githubAnswers(GITHUB_TOKENS);
    const response = await post("/api/github/token", GOOD_TOKEN_REQUEST, {
      "Content-Type": "text/plain",
    });
    expect(response.status).toBe(415);
    expect(spy).not.toHaveBeenCalled();
  });

  it("rejects a body over maxBodyBytes, declared or streamed", async () => {
    const spy = githubAnswers(GITHUB_TOKENS);
    const big = JSON.stringify({ ...GOOD_TOKEN_REQUEST, pad: "x".repeat(API_LIMITS.maxBodyBytes) });
    const declared = await post("/api/github/token", big);
    expect(declared.status).toBe(413);

    // No Content-Length: the cap must hold while reading, not only on the header.
    const bytes = new TextEncoder().encode(big);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < bytes.length; i += 512) controller.enqueue(bytes.slice(i, i + 512));
        controller.close();
      },
    });
    const streamed = await call("/api/github/token", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: ORIGIN },
      body: stream,
    });
    expect(streamed.status).toBe(413);
    expect(spy).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON and invalid fields without calling GitHub", async () => {
    const spy = githubAnswers(GITHUB_TOKENS);
    for (const body of [
      "{not json",
      { ...GOOD_TOKEN_REQUEST, code_verifier: "short" },
      { ...GOOD_TOKEN_REQUEST, code: "has spaces" },
      { code: "abc", redirect_uri: CALLBACK },
    ]) {
      const response = await post("/api/github/token", body);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "invalid_request" });
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it("passes GitHub's error code through with a 400, so the app can tell a bad code from an outage", async () => {
    githubAnswers({
      error: "bad_verification_code",
      error_description: "The code passed is incorrect",
    });
    const response = await post("/api/github/token", GOOD_TOKEN_REQUEST);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "bad_verification_code" });
  });

  it("answers 502 when GitHub blames the deployment's credentials, so a refresh keeps the user's tokens for a retry", async () => {
    // The app forgets its tokens on a 4xx (src/inputs/oauth.ts refreshNow) and retries on a 5xx.
    // A rotated or mistyped client secret is the operator's fault, not the user's grant.
    const spy = githubAnswers({ error: "incorrect_client_credentials" });
    const refresh = await post("/api/github/refresh", {
      refresh_token: GITHUB_TOKENS.refresh_token,
    });
    expect(refresh.status).toBe(502);
    expect(await refresh.json()).toEqual({ error: "github_misconfigured" });
    spy.mockResolvedValue(
      Response.json({ error: "redirect_uri_mismatch" }) as Awaited<ReturnType<typeof fetch>>,
    );
    expect((await post("/api/github/token", GOOD_TOKEN_REQUEST)).status).toBe(502);
    spy.mockResolvedValue(
      Response.json({ error: "bad_refresh_token" }) as Awaited<ReturnType<typeof fetch>>,
    );
    const revoked = await post("/api/github/refresh", {
      refresh_token: GITHUB_TOKENS.refresh_token,
    });
    expect(revoked.status).toBe(400);
  });

  it("answers 502 when GitHub is down or returns tokens without expiry", async () => {
    githubAnswers({ message: "down" }, 503);
    expect((await post("/api/github/token", GOOD_TOKEN_REQUEST)).status).toBe(502);
    vi.restoreAllMocks();
    // An app with "Expire user authorization tokens" off returns no refresh token.
    const { refresh_token: _r, refresh_token_expires_in: _e, ...noExpiry } = GITHUB_TOKENS;
    githubAnswers(noExpiry);
    const response = await post("/api/github/token", GOOD_TOKEN_REQUEST);
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain(noExpiry.access_token);
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("network"));
    expect((await post("/api/github/token", GOOD_TOKEN_REQUEST)).status).toBe(502);
  });

  it("is absent when oauth is not configured", async () => {
    const response = await post("/api/github/token", GOOD_TOKEN_REQUEST, {}, { ASSETS: assets });
    expect(response.status).toBe(404);
  });
});

describe("POST /api/github/refresh", () => {
  it("forwards the refresh token with grant_type refresh_token", async () => {
    const spy = githubAnswers(GITHUB_TOKENS);
    const response = await post("/api/github/refresh", {
      refresh_token: GITHUB_TOKENS.refresh_token,
    });
    expect(response.status).toBe(200);
    const { form } = await sentForm(spy);
    expect(Object.fromEntries(form)).toEqual({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      grant_type: "refresh_token",
      refresh_token: GITHUB_TOKENS.refresh_token,
    });
  });

  it("applies the same Origin and validation rules as the token endpoint", async () => {
    const spy = githubAnswers(GITHUB_TOKENS);
    const foreign = await post(
      "/api/github/refresh",
      { refresh_token: GITHUB_TOKENS.refresh_token },
      { Origin: "https://evil.example" },
    );
    expect(foreign.status).toBe(403);
    const invalid = await post("/api/github/refresh", { refresh_token: "nope" });
    expect(invalid.status).toBe(400);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("GET /api/remote/:room", () => {
  it("rejects room ids that are not 22-64 base64url characters", async () => {
    for (const room of ["short", "a".repeat(65), "has.dots.in.it.0123456789", "%2F".repeat(10)]) {
      const response = await SELF.fetch(`${ORIGIN}/api/remote/${room}`, {
        headers: { Upgrade: "websocket" },
      });
      expect({ room, status: response.status }).toEqual({ room, status: 400 });
    }
  });

  it("requires a WebSocket upgrade", async () => {
    const response = await SELF.fetch(`${ORIGIN}/api/remote/${"r".repeat(22)}`);
    expect(response.status).toBe(426);
  });

  it("is absent without the ROOMS binding", async () => {
    const response = await call(
      `/api/remote/${"r".repeat(22)}`,
      { headers: { Upgrade: "websocket" } },
      { ASSETS: assets },
    );
    expect(response.status).toBe(404);
  });
});

describe("fallthrough", () => {
  it("serves the SPA for paths the API does not own", async () => {
    const response = await call("/api/github/token");
    expect(await response.text()).toBe("<!doctype html>");
  });
});
