/**
 * The Content-Security-Policy, on its own so the build (`tooling/csp-plugin.ts`)
 * can read it without the Worker's runtime types.
 */

/**
 * The one inline script, `index.html`'s check for browsers below the floor
 * (decision 77). `tooling/csp-plugin.test.ts` fails when it no longer hashes
 * to this.
 */
export const FLOOR_CHECK_HASH = "sha256-DNz1wH6T/JrzumOiZ1PT9iOmppM4EqS+4jSEjJlxJn0=";

/** decision 34; `img-src` per decision 33, `connect-src` per decision 6: any https host the viewer confirmed, plus the relay. */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  `script-src 'self' '${FLOOR_CHECK_HASH}'`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' https: data: blob:",
  "worker-src 'self' blob:",
  "connect-src 'self' https: wss:",
  "font-src 'self' data:",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");
