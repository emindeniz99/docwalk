/**
 * The HTTP contract between the app and its optional Cloudflare Worker
 * (decisions 24, 36, 37, 38). The Worker stores nothing. In static mode
 * `/api/health` is missing and the app hides every feature listed here.
 */

/** GET /api/health */
export interface HealthResponse {
  ok: true;
  /** Features this deployment offers; "oauth" needs GitHub App credentials configured. */
  features: Array<"oauth" | "remote">;
  /** GitHub App client id for the authorize URL, when "oauth" is offered. */
  githubClientId?: string;
}

/**
 * POST /api/github/token, body JSON. Exchanges a GitHub App authorization
 * code for a user token. PKCE S256 and `state` are checked by the client
 * before calling; the Worker adds the client secret and forwards to
 * https://github.com/login/oauth/access_token. `redirect_uri` must equal the
 * app origin's callback (`<origin>/?oauth=callback`), checked by the Worker.
 */
export interface TokenRequest {
  code: string;
  code_verifier: string;
  redirect_uri: string;
}

/** POST /api/github/refresh, body JSON. */
export interface RefreshRequest {
  refresh_token: string;
}

/** Response of both token endpoints; errors use `{ error: string }` with a 4xx/5xx status. */
export interface TokenResponse {
  access_token: string;
  /** Seconds until the access token expires (GitHub App user tokens: 8 h). */
  expires_in: number;
  refresh_token: string;
  refresh_token_expires_in: number;
  token_type: "bearer";
}

/**
 * GET /api/remote/:room with `Upgrade: websocket` joins a remote-control room
 * (a Durable Object per room). Room ids are 22+ characters of base64url from
 * crypto.getRandomValues. The relay forwards opaque encrypted frames
 * (src/remote/types.ts) to every other socket in the room and never reads them.
 */
export const REMOTE_PATH = "/api/remote/";

/** Limits the Worker enforces; clients should respect them too. */
export const API_LIMITS = {
  /** Largest relayed WebSocket frame. Navigation events are tiny; this blocks abuse. */
  maxFrameBytes: 16 * 1024,
  /** Sockets per room: one presenter, phones and followers. */
  maxSocketsPerRoom: 50,
  /** Largest JSON body on the token endpoints. */
  maxBodyBytes: 4 * 1024,
} as const;
