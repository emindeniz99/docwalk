/**
 * GitHub App sign-in (decision 36): authorization code + PKCE `S256` +
 * `state`, exchanged by the Worker, which adds the client secret and stores
 * nothing. The token lands in `sessionStorage` through token.ts. In static
 * mode `/api/health` is missing and none of this is offered.
 */
import { useEffect, useState } from "react";
import * as v from "valibot";
import { m } from "../paraglide/messages.js";
import type { HealthResponse, RefreshRequest, TokenRequest, TokenResponse } from "../api/types";
import { readCapped, type FetchLike } from "./load";
import {
  clearToken,
  readRefresh,
  sessionStore,
  storeRefresh,
  storeToken,
  type StorageLike,
} from "./token";

/** PKCE verifier, `state` and the page to return to, between the redirect out and back. */
export const OAUTH_PENDING_KEY = "docwalk.oauth-pending";

const AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
/** A sign-in left half-done longer than this is not resumed. */
const PENDING_MAX_AGE_MS = 10 * 60_000;
/** Refresh this long before the access token expires. */
const REFRESH_LEAD_MS = 5 * 60_000;
/** After a network failure, retry the refresh this much later. */
const REFRESH_RETRY_MS = 60_000;
/** setTimeout's largest delay. */
const MAX_TIMEOUT_MS = 2 ** 31 - 1;
/** Largest JSON body read from `/api`. */
const MAX_API_BYTES = 16 * 1024;
/** Longest page address kept for the return trip (a long `#doc=` share fragment can exceed it). */
const MAX_RETURN_TO = 64 * 1024;

/** The browser globals sign-in touches, injectable so Node tests can run the whole flow. */
export interface OAuthEnv {
  fetch: FetchLike;
  storage: StorageLike | null;
  location: { origin: string; href: string; assign(url: string): void };
  history: { replaceState(data: unknown, unused: string, url?: string | null): void };
  now: () => number;
  setTimeout: (callback: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}

function environment(overrides: Partial<OAuthEnv>): OAuthEnv {
  const g = globalThis as unknown as Partial<OAuthEnv> & {
    window?: { location: OAuthEnv["location"]; history: OAuthEnv["history"] };
  };
  return {
    fetch: (input, init) => globalThis.fetch(input, init),
    storage: sessionStore(),
    location: g.window?.location ?? { origin: "", href: "", assign: () => {} },
    history: g.window?.history ?? { replaceState: () => {} },
    now: Date.now,
    setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
    clearTimeout: (handle) => globalThis.clearTimeout(handle as number),
    ...overrides,
  };
}

// ---- Validation -----------------------------------------------------------

/** GitHub App client ids (`Iv1.…`, `Iv23…`). */
const ClientIdSchema = v.pipe(v.string(), v.regex(/^[A-Za-z0-9._-]{1,128}$/));

const HealthSchema = v.object({
  ok: v.literal(true),
  features: v.pipe(v.array(v.string()), v.maxLength(32)),
  githubClientId: v.optional(v.string()),
});

const TokenResponseSchema = v.object({
  access_token: v.pipe(v.string(), v.regex(/^[A-Za-z0-9_]{20,255}$/)),
  expires_in: v.pipe(v.number(), v.integer(), v.minValue(60), v.maxValue(366 * 86_400)),
  refresh_token: v.pipe(v.string(), v.regex(/^[A-Za-z0-9_]{20,512}$/)),
  refresh_token_expires_in: v.pipe(v.number(), v.integer(), v.minValue(60)),
  token_type: v.pipe(
    v.string(),
    v.transform((t) => t.toLowerCase()),
    v.literal("bearer"),
  ),
});

const PendingSchema = v.object({
  verifier: v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{43,128}$/)),
  state: v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{22,128}$/)),
  createdAt: v.pipe(v.number(), v.finite()),
  /** Same-origin path to restore: starts with one `/`, never `//` or `/\`. */
  returnTo: v.pipe(v.string(), v.maxLength(MAX_RETURN_TO), v.regex(/^\/(?![/\\])/)),
});

type Pending = v.InferOutput<typeof PendingSchema>;

const CallbackSchema = v.object({
  code: v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{1,256}$/)),
  state: v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{22,128}$/)),
});

async function readJson(response: Response): Promise<unknown> {
  const body = await readCapped(response, MAX_API_BYTES);
  if (!body.ok) return null;
  try {
    return JSON.parse(new TextDecoder().decode(body.bytes)) as unknown;
  } catch {
    return null;
  }
}

// ---- Health ---------------------------------------------------------------

/**
 * GET /api/health, or null in static mode. A static host may answer with the
 * SPA's index.html and a 200, so the body is validated, not the status.
 */
export async function fetchApiHealth(
  fetchImpl: FetchLike = (input, init) => globalThis.fetch(input, init),
): Promise<HealthResponse | null> {
  try {
    const response = await fetchImpl("/api/health", {
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    });
    if (!response.ok) return null;
    const parsed = v.safeParse(HealthSchema, await readJson(response));
    if (!parsed.success) return null;
    const clientId = parsed.output.githubClientId;
    const hasClientId = clientId !== undefined && v.safeParse(ClientIdSchema, clientId).success;
    // Unknown features from a newer Worker are ignored; "oauth" without a client id is unusable.
    const features = parsed.output.features.filter(
      (f): f is "oauth" | "remote" => f === "remote" || (f === "oauth" && hasClientId),
    );
    return {
      ok: true,
      features: [...new Set(features)],
      ...(hasClientId && features.includes("oauth") ? { githubClientId: clientId } : {}),
    };
  } catch {
    return null;
  }
}

/** The Worker's features, or null while unknown and in static mode: hide OAuth and remote until then. */
export function useApiHealth(fetchImpl?: FetchLike): HealthResponse | null {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  useEffect(() => {
    let live = true;
    void fetchApiHealth(fetchImpl).then((result) => {
      if (live) setHealth(result);
    });
    return () => {
      live = false;
    };
  }, [fetchImpl]);
  return health;
}

// ---- PKCE -----------------------------------------------------------------

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function randomString(byteCount: number): string {
  return base64url(crypto.getRandomValues(new Uint8Array(byteCount)));
}

/** RFC 7636 §4.2: BASE64URL(SHA-256(ASCII(verifier))). */
export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

/** `<origin>/?oauth=callback`, the one redirect URI the Worker accepts. */
export function callbackUrl(origin: string): string {
  return `${origin}/?oauth=callback`;
}

// ---- Sign-in --------------------------------------------------------------

/**
 * Stores a fresh verifier and state, then sends the browser to GitHub's
 * authorize page. Returns the authorize URL (the redirect has started).
 */
export async function startLogin(clientId: string, env: Partial<OAuthEnv> = {}): Promise<string> {
  if (!v.safeParse(ClientIdSchema, clientId).success) throw new Error("Invalid GitHub client id");
  const { storage, location, now } = environment(env);
  if (storage === null) throw new Error("Sign-in needs sessionStorage");
  const here = new URL(location.href);
  // An address too long to store would make the callback fail validation and
  // read as an expired sign-in; drop the fragment, then the query, instead.
  const returnTo =
    [`${here.pathname}${here.search}${here.hash}`, `${here.pathname}${here.search}`].find(
      (candidate) => candidate.length <= MAX_RETURN_TO,
    ) ?? "/";
  const pending: Pending = {
    verifier: randomString(32),
    state: randomString(32),
    createdAt: now(),
    returnTo,
  };
  storage.setItem(OAUTH_PENDING_KEY, JSON.stringify(pending));
  const url = new URL(AUTHORIZE_URL);
  url.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: callbackUrl(location.origin),
    state: pending.state,
    code_challenge: await pkceChallenge(pending.verifier),
    code_challenge_method: "S256",
  }).toString();
  location.assign(url.href);
  return url.href;
}

export type LoginResult =
  | { kind: "none" }
  | { kind: "signed-in"; token: string; stopRefresh: () => void }
  | { kind: "error"; message: string };

/** Reads and deletes the pending record: a state is good for one callback only. */
function takePending(storage: StorageLike | null): Pending | null {
  try {
    const raw = storage?.getItem(OAUTH_PENDING_KEY);
    storage?.removeItem(OAUTH_PENDING_KEY);
    if (raw == null) return null;
    const result = v.safeParse(PendingSchema, JSON.parse(raw));
    return result.success ? result.output : null;
  } catch {
    return null;
  }
}

const CALLBACK_PARAMS = [
  "oauth",
  "code",
  "state",
  "error",
  "error_description",
  "error_uri",
  "installation_id",
  "setup_action",
];

/**
 * Handles `<origin>/?oauth=callback`: checks `state` against the stored
 * one, exchanges the code through the Worker, stores the token and
 * schedules its refresh. The code never stays in the address bar or
 * history, success or not. Returns `none` for any other URL.
 */
export async function completeLogin(
  input: string | URL,
  env: Partial<OAuthEnv> = {},
  onSignedOut?: () => void,
): Promise<LoginResult> {
  const full = environment(env);
  const url = new URL(input);
  if (url.searchParams.get("oauth") !== "callback") return { kind: "none" };
  const pending = takePending(full.storage);
  const params = Object.fromEntries(url.searchParams);
  for (const name of CALLBACK_PARAMS) url.searchParams.delete(name);
  full.history.replaceState(
    null,
    "",
    pending?.returnTo ?? `${url.pathname}${url.search}${url.hash}`,
  );

  if (params["error"] !== undefined) {
    return {
      kind: "error",
      message: params["error"] === "access_denied" ? m.oauth_cancelled() : m.oauth_failed(),
    };
  }
  const callback = v.safeParse(CallbackSchema, params);
  if (!callback.success) return { kind: "error", message: m.oauth_malformed() };
  if (pending === null || full.now() - pending.createdAt > PENDING_MAX_AGE_MS) {
    return { kind: "error", message: m.oauth_expired() };
  }
  if (callback.output.state !== pending.state) {
    // Not ours: a forged or replayed callback. The code is never sent anywhere.
    return { kind: "error", message: m.oauth_mismatch() };
  }

  const body: TokenRequest = {
    code: callback.output.code,
    code_verifier: pending.verifier,
    redirect_uri: callbackUrl(full.location.origin),
  };
  let token: string | null;
  try {
    token = await postToken(full, "/api/github/token", body);
  } catch {
    // Offline or the Worker is down: report it, so the caller's start-up goes on.
    token = null;
  }
  if (token === null) return { kind: "error", message: m.oauth_failed_retry() };
  return {
    kind: "signed-in",
    token,
    stopRefresh: scheduleRefresh(env, onSignedOut),
  };
}

/**
 * POSTs to a token endpoint and stores the result; the stored access token,
 * or null when the request was refused. Throws when it could not be answered
 * (network failure, 5xx), which a refresh treats as worth retrying.
 */
async function postToken(
  env: OAuthEnv,
  path: string,
  body: TokenRequest | RefreshRequest,
): Promise<string | null> {
  const response = await env.fetch(path, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    if (response.status >= 500) throw new Error(`Token endpoint answered ${response.status}`);
    return null;
  }
  const parsed = v.safeParse(TokenResponseSchema, await readJson(response));
  if (!parsed.success) return null;
  const tokens: TokenResponse = parsed.output;
  const now = env.now();
  if (!storeToken(tokens.access_token, env.storage)) return null;
  storeRefresh(
    {
      refreshToken: tokens.refresh_token,
      expiresAt: now + tokens.expires_in * 1000,
      refreshExpiresAt: now + tokens.refresh_token_expires_in * 1000,
    },
    env.storage,
  );
  return tokens.access_token;
}

/**
 * Trades the stored refresh token for a new pair. `rejected` (the Worker or
 * GitHub said no, or the refresh token expired) forgets the tokens; `failed`
 * (offline, 5xx) keeps them for a retry; `none` means there is no OAuth
 * session (a pasted token, or "Forget token"), and nothing is touched.
 */
export async function refreshNow(
  env: Partial<OAuthEnv> = {},
): Promise<"ok" | "rejected" | "failed" | "none"> {
  const full = environment(env);
  const record = readRefresh(full.storage);
  if (record === null) return "none";
  if (record.refreshExpiresAt <= full.now()) {
    clearToken(full.storage);
    return "rejected";
  }
  try {
    const body: RefreshRequest = { refresh_token: record.refreshToken };
    if ((await postToken(full, "/api/github/refresh", body)) !== null) return "ok";
  } catch {
    return "failed";
  }
  clearToken(full.storage);
  return "rejected";
}

/**
 * Keeps an OAuth token fresh: refreshes five minutes before `expires_in`
 * runs out, then re-arms from the new expiry. Call it on start-up too,
 * because the token survives a reload and the timer does not. Returns a
 * function that stops the chain; `onSignedOut` runs when the tokens are gone.
 */
export function scheduleRefresh(env: Partial<OAuthEnv> = {}, onSignedOut?: () => void) {
  const full = environment(env);
  let handle: unknown;
  let stopped = false;
  const arm = (delay: number) => {
    handle = full.setTimeout(
      () => {
        void refreshNow(env).then((outcome) => {
          // `none`: the user pasted their own token or forgot it; neither is ours to clear.
          if (stopped || outcome === "none") return;
          const next = nextDelay();
          if (outcome === "ok" && next !== null) return arm(next);
          const record = readRefresh(full.storage);
          if (outcome === "failed" && record && record.expiresAt > full.now()) {
            return arm(REFRESH_RETRY_MS);
          }
          clearToken(full.storage);
          onSignedOut?.();
        });
      },
      Math.min(Math.max(delay, 0), MAX_TIMEOUT_MS),
    );
  };
  const nextDelay = () => {
    const record = readRefresh(full.storage);
    return record === null ? null : record.expiresAt - REFRESH_LEAD_MS - full.now();
  };
  const first = nextDelay();
  if (first !== null) arm(first);
  return () => {
    stopped = true;
    full.clearTimeout(handle);
  };
}
