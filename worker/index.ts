/**
 * docwalk's optional Worker (decisions 24, 36, 38): GitHub App token
 * exchange, the remote-control relay and the static app. It stores nothing
 * and logs nothing. Every request body is validated (decision 46).
 */
import { Hono, type Context } from "hono";
import * as v from "valibot";
import { API_LIMITS, type HealthResponse, type TokenResponse } from "../src/api/types";
import type { Env } from "./env";
import { withSecurityHeaders } from "./headers";

export { RemoteRoom } from "./room";
export type { Env } from "./env";

const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
/** Largest GitHub token response read; a real one is under 1 KB. */
const MAX_UPSTREAM_BYTES = 16 * 1024;

type AppContext = Context<{ Bindings: Env }>;

// ---- Validation ------------------------------------------------------------

const TokenRequestSchema = v.object({
  code: v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{1,256}$/)),
  // RFC 7636 §4.1: 43-128 unreserved characters.
  code_verifier: v.pipe(v.string(), v.regex(/^[A-Za-z0-9._~-]{43,128}$/)),
  redirect_uri: v.pipe(v.string(), v.maxLength(2048)),
});

const RefreshRequestSchema = v.object({
  refresh_token: v.pipe(v.string(), v.regex(/^[A-Za-z0-9_]{20,512}$/)),
});

/** Room ids are 22+ characters of base64url from crypto.getRandomValues (src/api/types.ts). */
const RoomIdSchema = v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{22,64}$/));

const GitHubTokenSchema = v.object({
  access_token: v.pipe(v.string(), v.regex(/^[A-Za-z0-9_]{20,255}$/)),
  expires_in: v.pipe(v.number(), v.integer(), v.minValue(1)),
  // Missing when the GitHub App has "Expire user authorization tokens" off.
  refresh_token: v.pipe(v.string(), v.regex(/^[A-Za-z0-9_]{20,512}$/)),
  refresh_token_expires_in: v.pipe(v.number(), v.integer(), v.minValue(1)),
  token_type: v.pipe(
    v.string(),
    v.transform((type) => type.toLowerCase()),
    v.literal("bearer"),
  ),
});

/** GitHub answers a bad code or refresh token with 200 and `{ error: "<code>" }`. */
const GitHubErrorSchema = v.object({
  error: v.pipe(v.string(), v.regex(/^[a-z_]{1,64}$/)),
});

/** GitHub error codes that blame this Worker's GitHub App settings, not the user's grant. */
const DEPLOYMENT_ERRORS: ReadonlySet<string> = new Set([
  "incorrect_client_credentials",
  "redirect_uri_mismatch",
]);

// ---- Helpers ---------------------------------------------------------------

/** `{ error }` with `Cache-Control: no-store`, the error shape of src/api/types.ts. */
function fail(c: AppContext, error: string, status: 400 | 403 | 404 | 413 | 415 | 426 | 500 | 502) {
  return c.json({ error }, status, { "Cache-Control": "no-store" });
}

/** APP_ORIGIN, or the request's own origin when unset; null when APP_ORIGIN is not a URL. */
function appOrigin(c: AppContext): string | null {
  const configured = c.env.APP_ORIGIN?.trim();
  if (!configured) return new URL(c.req.url).origin;
  try {
    return new URL(configured).origin;
  } catch {
    return null;
  }
}

function oauthConfigured(
  env: Env,
): env is Env & { GITHUB_CLIENT_ID: string; GITHUB_CLIENT_SECRET: string } {
  return Boolean(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET);
}

/** Reads at most `max` bytes; null when the stream is longer. */
async function readCapped(
  body: ReadableStream<Uint8Array> | null,
  max: number,
): Promise<string | null> {
  if (body === null) return "";
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

// ---- Token exchange --------------------------------------------------------

/**
 * Shared front half of both token endpoints: configuration, origin, content
 * type and body size. Returns the parsed JSON body or the error response.
 */
async function readTokenRequest(
  c: AppContext,
): Promise<{ origin: string; body: unknown } | { response: Response }> {
  if (!oauthConfigured(c.env)) return { response: fail(c, "oauth_not_configured", 404) };
  const origin = appOrigin(c);
  if (origin === null) return { response: fail(c, "misconfigured", 500) };
  // Same-origin only: browsers always send Origin on a POST, and no CORS headers are ever sent.
  if (c.req.header("Origin") !== origin) return { response: fail(c, "forbidden_origin", 403) };
  if (!c.req.header("Content-Type")?.toLowerCase().startsWith("application/json")) {
    return { response: fail(c, "unsupported_media_type", 415) };
  }
  const declared = Number(c.req.header("Content-Length") ?? 0);
  if (declared > API_LIMITS.maxBodyBytes) return { response: fail(c, "body_too_large", 413) };
  const text = await readCapped(c.req.raw.body, API_LIMITS.maxBodyBytes);
  if (text === null) return { response: fail(c, "body_too_large", 413) };
  return { origin, body: parseJson(text) };
}

/** Posts the form to GitHub and returns only the TokenResponse fields. Never logs. */
async function exchange(c: AppContext, params: Record<string, string>): Promise<Response> {
  const env = c.env as Env & { GITHUB_CLIENT_ID: string; GITHUB_CLIENT_SECRET: string };
  let upstream: Response;
  try {
    upstream = await fetch(GITHUB_TOKEN_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "docwalk",
      },
      body: new URLSearchParams({
        client_id: env.GITHUB_CLIENT_ID,
        client_secret: env.GITHUB_CLIENT_SECRET,
        ...params,
      }),
    });
  } catch {
    return fail(c, "github_unreachable", 502);
  }
  if (!upstream.ok) {
    await upstream.body?.cancel();
    return fail(c, "github_unavailable", 502);
  }
  const text = await readCapped(upstream.body, MAX_UPSTREAM_BYTES);
  const json = text === null ? undefined : parseJson(text);
  const tokens = v.safeParse(GitHubTokenSchema, json);
  if (tokens.success) {
    const body: TokenResponse = {
      access_token: tokens.output.access_token,
      expires_in: tokens.output.expires_in,
      refresh_token: tokens.output.refresh_token,
      refresh_token_expires_in: tokens.output.refresh_token_expires_in,
      token_type: tokens.output.token_type,
    };
    return c.json(body, 200, { "Cache-Control": "no-store" });
  }
  const rejected = v.safeParse(GitHubErrorSchema, json);
  if (rejected.success) {
    // A 4xx makes the app forget its tokens; a broken deployment must not sign everyone out.
    if (DEPLOYMENT_ERRORS.has(rejected.output.error)) return fail(c, "github_misconfigured", 502);
    return fail(c, rejected.output.error, 400);
  }
  return fail(c, "unexpected_github_response", 502);
}

// ---- Routes ----------------------------------------------------------------

const app = new Hono<{ Bindings: Env }>();

// Hono's default handler logs the error; an error here must not reach a log.
app.onError((_error, c) => fail(c, "internal_error", 500));

app.get("/api/health", (c) => {
  const oauth = oauthConfigured(c.env);
  const features: HealthResponse["features"] = [];
  if (oauth) features.push("oauth");
  if (c.env.ROOMS) features.push("remote");
  const body: HealthResponse = {
    ok: true,
    features,
    ...(oauth ? { githubClientId: c.env.GITHUB_CLIENT_ID } : {}),
  };
  return c.json(body, 200, { "Cache-Control": "no-store" });
});

app.post("/api/github/token", async (c) => {
  const request = await readTokenRequest(c);
  if ("response" in request) return request.response;
  const parsed = v.safeParse(TokenRequestSchema, request.body);
  if (!parsed.success) return fail(c, "invalid_request", 400);
  // The one redirect URI GitHub may send a code to; anything else is a code meant for another app.
  if (parsed.output.redirect_uri !== new URL("/?oauth=callback", request.origin).href) {
    return fail(c, "invalid_redirect_uri", 400);
  }
  return exchange(c, {
    code: parsed.output.code,
    code_verifier: parsed.output.code_verifier,
    redirect_uri: parsed.output.redirect_uri,
  });
});

app.post("/api/github/refresh", async (c) => {
  const request = await readTokenRequest(c);
  if ("response" in request) return request.response;
  const parsed = v.safeParse(RefreshRequestSchema, request.body);
  if (!parsed.success) return fail(c, "invalid_request", 400);
  return exchange(c, { grant_type: "refresh_token", refresh_token: parsed.output.refresh_token });
});

app.get("/api/remote/:room", async (c) => {
  const rooms = c.env.ROOMS;
  if (!rooms) return fail(c, "remote_not_configured", 404);
  const room = c.req.param("room");
  if (!v.safeParse(RoomIdSchema, room).success) return fail(c, "invalid_room", 400);
  if (c.req.header("Upgrade")?.toLowerCase() !== "websocket") {
    return fail(c, "websocket_required", 426);
  }
  return rooms.get(rooms.idFromName(room)).fetch(c.req.raw);
});

// Everything else is the SPA (not_found_handling serves index.html).
app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

export default {
  async fetch(request, env, ctx) {
    return withSecurityHeaders(await app.fetch(request, env, ctx));
  },
} satisfies ExportedHandler<Env>;
