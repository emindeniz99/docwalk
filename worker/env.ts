import type { RemoteRoom } from "./room";

/** Bindings from wrangler.jsonc plus the two secrets set with `wrangler secret put`. */
export interface Env {
  ASSETS: Fetcher;
  /** Absent when a self-hoster drops the Durable Object: "remote" is then not offered. */
  ROOMS?: DurableObjectNamespace<RemoteRoom>;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  /** The app's origin, e.g. `https://docwalk.example`; empty means the request's own origin. */
  APP_ORIGIN?: string;
}
